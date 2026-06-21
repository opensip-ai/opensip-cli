/**
 * Optional CPU profiling (ADR-0049). Three layers:
 *
 * 1. Gate + idempotency unit tests — pure env logic and the scope-state reuse /
 *    stop-when-idle / reset paths.
 * 2. Callback-arm unit tests (`synchronous fake inspector session`) — inject a
 *    fake Session whose `post()` fires synchronously, so the start/stop callback
 *    bodies (label write, profile write, stop-error, cleanup) are exercised
 *    DETERMINISTICALLY. This is the source of profiling.ts branch coverage.
 * 3. Real-inspector end-to-end (`uninstrumented child process`) — spawns a child
 *    that drives Node's real CPU profiler and asserts the artifacts land. It runs
 *    out-of-process because the real profiler (inspector-based) races with
 *    `@vitest/coverage-v8` (also inspector-based) and corrupts in-process
 *    coverage collection for this file. See the driver fixture for the rationale.
 *
 * Scope-owned profiling state (and the injected session factory) is reset around
 * every test.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __setInspectorSessionFactoryForTests,
  isProfilingEnabled,
  resetProfilingForTests,
  startProfiling,
  stopProfiling,
  type InspectorSession,
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

/**
 * Genuine end-to-end verification of the REAL `node:inspector` CPU-profiler path
 * — driven in a CHILD PROCESS, not in-process.
 *
 * Node's CPU profiler is process-global and inspector-based; in-process it races
 * with `@vitest/coverage-v8` (also inspector-based), corrupting coverage-v8's
 * data collection for profiling.ts non-deterministically (the file's branch
 * coverage flickered between runs, dropping the package below its floor). The
 * deterministic branch coverage now comes from the fake-session unit tests
 * below; this suite spawns an uninstrumented child that runs the real profiler
 * so the genuine wiring (real Session → real .cpuprofile + labels sidecar) is
 * still proven, without poisoning coverage. This mirrors the cli's existing
 * subprocess-e2e pattern for behaviour that can't be observed under in-process
 * instrumentation.
 *
 * The build must exist (the driver imports the compiled dist module) — the same
 * precondition as e2e.test.ts.
 */
describe('CPU profiling — real inspector session (uninstrumented child process)', () => {
  const driver = fileURLToPath(new URL('fixtures/real-profiler-driver.mjs', import.meta.url));

  function runDriver(mode: 'project' | 'noscope'): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [driver, mode, tmp], {
      encoding: 'utf8',
      // No coverage instrumentation in the child; generous cap for a real profile.
      timeout: 30_000,
    });
  }

  it('writes a real .cpuprofile + labels sidecar across a project-scoped start → stop', () => {
    const res = runDriver('project');
    expect(res.status, `driver stderr: ${res.stderr}`).toBe(0);

    expect(readdirHasCpuprofile()).toBe(true);
    expect(readdirHasLabels()).toBe(true);
    const labels = JSON.parse(readFileSync(labelsFile(), 'utf8')) as Record<string, unknown>;
    expect(labels.runId).toBe('RUN_PROF_1');
    expect(labels.command).toBe('fit:run');
    expect(labels.service).toBe('opensip-cli');
  });

  it('uses cwd profile storage and default command labels outside project scope', () => {
    const res = runDriver('noscope');
    expect(res.status, `driver stderr: ${res.stderr}`).toBe(0);

    const files = readdir();
    expect(files.some((file) => file.includes('-cli-RUN_NO_PROJECT.'))).toBe(true);
    expect(files.some((file) => file.endsWith('.cpuprofile'))).toBe(true);
    const labels = JSON.parse(readFileSync(labelsFile(), 'utf8')) as Record<string, unknown>;
    expect(labels.runId).toBe('RUN_NO_PROJECT');
    expect(labels.command).toBe('unknown');
  });
});

/**
 * Deterministic coverage of the inner inspector-callback arms.
 *
 * The "real inspector" suite above drives Node's process-global CPU profiler,
 * whose `Profiler.start`/`Profiler.stop` callbacks fire asynchronously and — under
 * the `@vitest/coverage-v8` lane, which owns its own inspector session — at
 * non-deterministic times relative to the test's `waitFor`. That made this file's
 * branch coverage flaky (the label/profile-write and error arms were sometimes
 * unobserved, dropping the package below its branch floor). Here we inject a fake
 * session whose `post()` invokes the callback synchronously, so every arm of the
 * start callback (label write) and the stop callback (profile write, stop-error,
 * cleanup) is exercised every run, regardless of the real profiler's timing.
 */
describe('CPU profiling callback arms (synchronous fake inspector session)', () => {
  interface FakeOptions {
    /** Profile payload delivered to the Profiler.stop callback (undefined ⇒ none). */
    readonly profile?: unknown;
    /** Error delivered to the Profiler.stop callback (exercises the err arm). */
    readonly stopError?: Error;
    /** Throw from connect() to exercise startProfiling's catch + cleanup. */
    readonly throwOnConnect?: boolean;
    /** Throw from disconnect() to exercise cleanup's swallow-ok arm. */
    readonly throwOnDisconnect?: boolean;
  }

  function installFakeSession(opts: FakeOptions = {}): {
    connected: boolean;
    disconnected: boolean;
  } {
    const flags = { connected: false, disconnected: false };
    const fake: InspectorSession = {
      connect() {
        if (opts.throwOnConnect) throw new Error('connect boom');
        flags.connected = true;
      },
      disconnect() {
        flags.disconnected = true;
        if (opts.throwOnDisconnect) throw new Error('disconnect boom');
      },
      post(method: string, callback?: (err: Error | null, params?: unknown) => void): void {
        if (!callback) return;
        if (method === 'Profiler.stop') {
          // Mirror node:inspector's (err, params) shape for the stop wire call.
          callback(opts.stopError ?? null, { profile: opts.profile });
          return;
        }
        // Profiler.enable / Profiler.start succeed synchronously.
        callback(null);
      },
    };
    __setInspectorSessionFactoryForTests(() => fake);
    return flags;
  }

  // ONE scope per test, reused for start + stop. `scopeFor()` builds a fresh
  // `telemetry: {}` each call, so passing distinct scope objects to start vs stop
  // would thread distinct profiling states; binding a single scope mirrors how a
  // real invocation carries one RunScope through start → stop.
  let scope: RunScope;

  beforeEach(() => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    process.env[GATE] = '1';
    scope = scopeFor();
  });

  afterEach(() => {
    __setInspectorSessionFactoryForTests(undefined);
  });

  it('writes the labels sidecar synchronously on start and the .cpuprofile on stop', () => {
    installFakeSession({ profile: { nodes: [], samples: [] } });

    startProfiling(scope, 'fit:run');
    // The label sidecar is written from the (now-synchronous) Profiler.start callback.
    expect(readdirHasLabels()).toBe(true);
    const labels = JSON.parse(readFileSync(labelsFile(), 'utf8')) as Record<string, unknown>;
    expect(labels.runId).toBe('RUN_PROF_1');
    expect(labels.command).toBe('fit:run');

    const info = vi.spyOn(logger, 'info');
    stopProfiling(scope);
    expect(readdirHasCpuprofile()).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ evt: 'cli.profiling.stopped' }));
  });

  it('logs and writes nothing when Profiler.stop returns an error', () => {
    installFakeSession({ stopError: new Error('profiler exploded') });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    startProfiling(scope, 'fit');
    expect(readdirHasLabels()).toBe(true);

    stopProfiling(scope);
    // The error arm logs a stop_failed warning and skips the .cpuprofile write.
    expect(readdirHasCpuprofile()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.profiling.stop_failed' }),
    );
  });

  it('does not write a .cpuprofile when Profiler.stop returns no profile', () => {
    installFakeSession({ profile: undefined });

    startProfiling(scope, 'fit');
    expect(readdirHasLabels()).toBe(true);

    stopProfiling(scope);
    // result.profile is falsy ⇒ neither write nor error branch runs; just cleanup.
    expect(readdirHasCpuprofile()).toBe(false);
  });

  it('falls back to the active state when stopProfiling is called without a scope', () => {
    installFakeSession({ profile: { nodes: [] } });

    // No scope ⇒ profiling runs on the module fallback state and artifacts land
    // under cwd/.runtime/profiles (no projectContext). chdir to tmp so the
    // profiles-dir helper observes them. Stop without a scope must resolve that
    // same active state via `activeProfilingState` and still flush the profile.
    const previousCwd = process.cwd();
    process.chdir(tmp);
    try {
      startProfiling(undefined, 'fit');
      expect(readdirHasLabels()).toBe(true);

      stopProfiling();
      expect(readdirHasCpuprofile()).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('survives a connect() failure (best-effort: no throw, profiling stays off)', () => {
    installFakeSession({ throwOnConnect: true });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(() => startProfiling(scope, 'fit')).not.toThrow();
    expect(readdirHasLabels()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.profiling.start_failed' }),
    );
    // A failed start leaves no active profile, so a subsequent stop is a no-op.
    expect(() => stopProfiling(scope)).not.toThrow();
  });

  it('swallows a disconnect() failure during cleanup', () => {
    const flags = installFakeSession({ profile: { nodes: [] }, throwOnDisconnect: true });

    startProfiling(scope, 'fit');
    expect(() => stopProfiling(scope)).not.toThrow();
    // cleanup attempted the disconnect (and swallowed its throw).
    expect(flags.disconnected).toBe(true);
  });
});
