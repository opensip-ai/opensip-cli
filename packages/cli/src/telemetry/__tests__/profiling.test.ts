/**
 * Optional CPU profiling (ADR-0049). The gate is pure env logic; the start →
 * write → stop → write path uses a real Node `inspector` session, so the happy
 * path is an integration test that drives an actual short profile into a temp
 * project dir and asserts the .cpuprofile + labels sidecar land. The gate-closed
 * no-op, double-start idempotency, stop-when-idle, and reset paths are unit
 * tests. Scope-owned profiling state is reset around every test.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logger } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isProfilingEnabled,
  resetProfilingForTests,
  startProfiling,
  stopProfiling,
} from '../profiling.js';

import type { RunScope } from '@opensip-cli/core';

const ENDPOINT = 'OTEL_EXPORTER_OTLP_ENDPOINT';
const GATE = 'OPENSIP_PROFILING';

let saved: Record<string, string | undefined>;
let tmp: string;

beforeEach(() => {
  saved = { [ENDPOINT]: process.env[ENDPOINT], [GATE]: process.env[GATE] };
  delete process.env[ENDPOINT];
  delete process.env[GATE];
  tmp = mkdtempSync(join(tmpdir(), 'ost-profiling-'));
  resetProfilingForTests();
});

afterEach(() => {
  resetProfilingForTests();
  vi.restoreAllMocks();
  for (const k of [ENDPOINT, GATE]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for profiling artifact');
    await new Promise((r) => setTimeout(r, 15));
  }
}

function scopeFor(): RunScope {
  return {
    runId: 'RUN_PROF_1',
    projectContext: { scope: 'project', projectRoot: tmp },
    telemetry: {},
  } as unknown as RunScope;
}

function nonProjectScope(): RunScope {
  return {
    runId: 'RUN_NO_PROJECT',
    telemetry: {},
  } as unknown as RunScope;
}

function profilesDir(): string {
  return join(tmp, 'opensip-cli/.runtime/profiles');
}

// Small fs helpers over the temp profiles dir (module-scoped so they don't
// capture describe state).
function readdir(): string[] {
  try {
    return readdirSync(profilesDir());
  } catch {
    return [];
  }
}
function readdirHasLabels(): boolean {
  return readdir().some((f) => f.endsWith('.labels.json'));
}
function readdirHasCpuprofile(): boolean {
  return readdir().some((f) => f.endsWith('.cpuprofile'));
}
function labelsFile(): string {
  const f = readdir().find((x) => x.endsWith('.labels.json'));
  if (!f) throw new Error('no labels file');
  return join(profilesDir(), f);
}

describe('isProfilingEnabled', () => {
  it('is false without an OTLP endpoint', () => {
    expect(isProfilingEnabled()).toBe(false);
  });

  it('is true when the gate is explicitly 1/true and an endpoint is set', () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    process.env[GATE] = '1';
    expect(isProfilingEnabled()).toBe(true);
    process.env[GATE] = 'true';
    expect(isProfilingEnabled()).toBe(true);
  });

  it('falls back to ON when only the OTLP endpoint is set (OTEL-only mode)', () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    expect(isProfilingEnabled()).toBe(true);
  });

  it('honors explicit 0/false as force-off even when the OTLP endpoint is set', () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    process.env[GATE] = '0';
    expect(isProfilingEnabled()).toBe(false);
    process.env[GATE] = 'false';
    expect(isProfilingEnabled()).toBe(false);
  });
});

describe('startProfiling / stopProfiling — gate + idempotency', () => {
  it('is a no-op when the gate is closed (no session, no files)', () => {
    startProfiling(scopeFor(), 'fit');
    expect(existsSync(profilesDir())).toBe(false);
  });

  it('reuses an existing scope-owned profiling state when present', () => {
    const existing = {
      session: null,
      isProfiling: false,
      profilePath: null,
      labelsPath: null,
    };
    const scope = {
      runId: 'RUN_EXISTING',
      projectContext: { scope: 'project', projectRoot: tmp },
      telemetry: { profiling: existing },
    } as unknown as RunScope;

    startProfiling(scope, 'fit');

    expect((scope.telemetry as { profiling?: unknown }).profiling).toBe(existing);
    expect(existsSync(profilesDir())).toBe(false);
  });

  it('stopProfiling when not profiling is a safe no-op', () => {
    expect(() => stopProfiling()).not.toThrow();
  });

  it('emits one cost warning in OTEL-only mode', async () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    startProfiling(scopeFor(), 'fit');
    await waitFor(() => existsSync(profilesDir()) && readdirHasLabels());
    startProfiling(scopeFor(), 'fit');
    stopProfiling();
    await waitFor(() => readdirHasCpuprofile());

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.profiling.otel_only_enabled' }),
    );
  });

  it('resetProfilingForTests is safe to call repeatedly', () => {
    expect(() => {
      resetProfilingForTests();
      resetProfilingForTests();
    }).not.toThrow();
  });
});

describe('CPU profiling integration (real inspector session)', () => {
  it('writes a .cpuprofile and a labels sidecar across a start → stop cycle', async () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    process.env[GATE] = '1';

    startProfiling(scopeFor(), 'fit:run');
    // The labels sidecar is written from the (async) Profiler.start callback.
    await waitFor(() => existsSync(profilesDir()) && readdirHasLabels());

    // A little CPU work so the profiler captures samples before we stop.
    let acc = 0;
    for (let i = 0; i < 1e5; i++) acc += Math.sqrt(i);
    expect(acc).toBeGreaterThan(0);

    let cpuprofileWritten = false;
    stopProfiling();
    await waitFor(() => {
      cpuprofileWritten = readdirHasCpuprofile();
      return cpuprofileWritten;
    });
    expect(cpuprofileWritten).toBe(true);

    // The labels sidecar carries the runId + safe command name.
    const labels = JSON.parse(readFileSync(labelsFile(), 'utf8')) as Record<string, unknown>;
    expect(labels.runId).toBe('RUN_PROF_1');
    expect(labels.command).toBe('fit:run');
    expect(labels.service).toBe('opensip-cli');
  });

  it('double start is idempotent (the second call returns immediately)', async () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    process.env[GATE] = '1';
    startProfiling(scopeFor(), 'fit');
    await waitFor(() => existsSync(profilesDir()) && readdirHasLabels());
    // Second start short-circuits on the isProfiling guard — no throw, no new run.
    expect(() => startProfiling(scopeFor(), 'fit')).not.toThrow();
    stopProfiling();
    await waitFor(() => readdirHasCpuprofile());
  });

  it('uses cwd profile storage and default command labels outside project scope', async () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    process.env[GATE] = '1';
    const previousCwd = process.cwd();
    process.chdir(tmp);
    try {
      startProfiling(nonProjectScope());
      await waitFor(() => existsSync(profilesDir()) && readdirHasLabels());

      stopProfiling();
      await waitFor(() => readdirHasCpuprofile());

      const files = readdir();
      expect(files.some((file) => file.includes('-cli-RUN_NO_PROJECT.'))).toBe(true);
      const labels = JSON.parse(readFileSync(labelsFile(), 'utf8')) as Record<string, unknown>;
      expect(labels.runId).toBe('RUN_NO_PROJECT');
      expect(labels.command).toBe('unknown');
    } finally {
      process.chdir(previousCwd);
    }
  });
});
