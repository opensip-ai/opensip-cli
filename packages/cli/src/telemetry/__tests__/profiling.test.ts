/**
 * Optional CPU profiling (ADR-0049) — gate logic + idempotency.
 *
 * This file covers the pure env-gate (`isProfilingEnabled`) and the
 * start/stop scope-state reuse / stop-when-idle / OTEL-only-warning / reset
 * paths. The inner inspector-callback arms (label/profile write, stop-error, the
 * WIRE-throw catch, cleanup) are exercised in the sibling
 * `profiling-callback-arms.test.ts`; the genuine real-`node:inspector` wiring is
 * proven out-of-process in `profiling-real-inspector.e2e.test.ts`. All three
 * build on `fixtures/profiling-test-harness.ts`.
 *
 * Why the real-inspector suite is a SEPARATE FILE (and why every gate-open test
 * here uses the SYNCHRONOUS fake session): Node's CPU profiler is inspector-based
 * and process-global. Run in-process — even when driven via blocking `spawnSync`
 * in an uninstrumented child — it corrupts `@vitest/coverage-v8`'s precise-
 * coverage counters for profiling.ts, intermittently dropping the fake-session
 * callback arms and flickering the cli package below its 84% branch floor.
 * vitest's `forks` pool isolates each test FILE in its own worker, so keeping the
 * real profiler out of these files makes profiling.ts branch coverage
 * deterministic in isolation AND in the full run.
 */

import { logger } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import {
  isProfilingEnabled,
  resetProfilingForTests,
  startProfiling,
  stopProfiling,
} from '../profiling.js';

import { createProfilingHarness, ENDPOINT, GATE } from './fixtures/profiling-test-harness.js';

import type { RunScope } from '@opensip-cli/core';

const h = createProfilingHarness();

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
    startProfiling(h.scopeFor(), 'fit');
    expect(h.profilesDirExists()).toBe(false);
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
      projectContext: { scope: 'project', projectRoot: h.tmp() },
      telemetry: { profiling: existing },
    } as unknown as RunScope;

    startProfiling(scope, 'fit');

    expect((scope.telemetry as { profiling?: unknown }).profiling).toBe(existing);
    expect(h.profilesDirExists()).toBe(false);
  });

  it('stopProfiling when not profiling is a safe no-op', () => {
    expect(() => stopProfiling()).not.toThrow();
  });

  it('emits one cost warning in OTEL-only mode', () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    // A SYNCHRONOUS fake session — never the real inspector (see the harness note
    // on coverage poisoning). The label/profile artifacts land inline, so no
    // async waitFor is needed.
    h.installSyncFakeSession({ profile: { nodes: [] } });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    startProfiling(h.scopeFor(), 'fit');
    expect(h.profilesDirExists() && h.readdirHasLabels()).toBe(true);
    startProfiling(h.scopeFor(), 'fit'); // idempotent re-entry: must not re-warn
    stopProfiling();
    expect(h.readdirHasCpuprofile()).toBe(true);

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
