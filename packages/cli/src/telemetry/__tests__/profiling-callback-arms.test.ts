/**
 * Optional CPU profiling (ADR-0049) — deterministic coverage of the inner
 * inspector-callback arms.
 *
 * Every test here injects the harness's SYNCHRONOUS fake inspector session, whose
 * `post()` invokes the `Profiler.enable`/`start`/`stop` callbacks inline. So every
 * arm of the start callback (label write, `?? cli`/`?? unknown` command defaults)
 * and the stop callback (profile write, stop-error, the WIRE-throw catch + its
 * `String(error)` else, cleanup) — plus the start-catch and the per-state /
 * active-state guards — is exercised every run, in-process, with NO real
 * `node:inspector` session. That is what keeps profiling.ts branch coverage
 * deterministic (the real profiler is inspector-based and corrupts coverage-v8's
 * counters; it is proven out-of-process in `profiling-real-inspector.e2e.test.ts`).
 */

import { readFileSync } from 'node:fs';

import { logger } from '@opensip-cli/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetProfilingForTests, startProfiling, stopProfiling } from '../profiling.js';

import { createProfilingHarness, ENDPOINT, GATE } from './fixtures/profiling-test-harness.js';

import type { RunScope } from '@opensip-cli/core';

const h = createProfilingHarness();

describe('CPU profiling callback arms (synchronous fake inspector session)', () => {
  // ONE scope per test, reused for start + stop. `scopeFor()` builds a fresh
  // `telemetry: {}` each call, so passing distinct scope objects to start vs stop
  // would thread distinct profiling states; binding a single scope mirrors how a
  // real invocation carries one RunScope through start → stop.
  let scope: RunScope;

  beforeEach(() => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    process.env[GATE] = '1';
    scope = h.scopeFor();
  });

  it('writes the labels sidecar synchronously on start and the .cpuprofile on stop', () => {
    h.installSyncFakeSession({ profile: { nodes: [], samples: [] } });

    startProfiling(scope, 'fit:run');
    // The label sidecar is written from the (now-synchronous) Profiler.start callback.
    expect(h.readdirHasLabels()).toBe(true);
    const labels = JSON.parse(readFileSync(h.labelsFile(), 'utf8')) as Record<string, unknown>;
    expect(labels.runId).toBe('RUN_PROF_1');
    expect(labels.command).toBe('fit:run');

    const info = vi.spyOn(logger, 'info');
    stopProfiling(scope);
    expect(h.readdirHasCpuprofile()).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ evt: 'cli.profiling.stopped' }));
  });

  it('logs and writes nothing when Profiler.stop returns an error', () => {
    h.installSyncFakeSession({ stopError: new Error('profiler exploded') });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    startProfiling(scope, 'fit');
    expect(h.readdirHasLabels()).toBe(true);

    stopProfiling(scope);
    // The error arm logs a stop_failed warning and skips the .cpuprofile write.
    expect(h.readdirHasCpuprofile()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.profiling.stop_failed' }),
    );
  });

  it('does not write a .cpuprofile when Profiler.stop returns no profile', () => {
    h.installSyncFakeSession({ profile: undefined });

    startProfiling(scope, 'fit');
    expect(h.readdirHasLabels()).toBe(true);

    stopProfiling(scope);
    // result.profile is falsy ⇒ neither write nor error branch runs; just cleanup.
    expect(h.readdirHasCpuprofile()).toBe(false);
  });

  it('falls back to the active state when stopProfiling is called without a scope', () => {
    h.installSyncFakeSession({ profile: { nodes: [] } });

    // No scope ⇒ profiling runs on the module fallback state and artifacts land
    // under cwd/.runtime/profiles (no projectContext). chdir to tmp so the
    // profiles-dir helper observes them. Stop without a scope must resolve that
    // same active state via `activeProfilingState` and still flush the profile.
    const previousCwd = process.cwd();
    process.chdir(h.tmp());
    try {
      startProfiling(undefined, 'fit');
      expect(h.readdirHasLabels()).toBe(true);

      stopProfiling();
      expect(h.readdirHasCpuprofile()).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('survives a connect() failure (best-effort: no throw, profiling stays off)', () => {
    h.installSyncFakeSession({ throwOnConnect: true });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(() => startProfiling(scope, 'fit')).not.toThrow();
    expect(h.readdirHasLabels()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.profiling.start_failed' }),
    );
    // A failed start leaves no active profile, so a subsequent stop is a no-op.
    expect(() => stopProfiling(scope)).not.toThrow();
  });

  it('swallows a disconnect() failure during cleanup', () => {
    const flags = h.installSyncFakeSession({
      profile: { nodes: [] },
      throwOnDisconnect: true,
    });

    startProfiling(scope, 'fit');
    expect(() => stopProfiling(scope)).not.toThrow();
    // cleanup attempted the disconnect (and swallowed its throw).
    expect(flags.disconnected).toBe(true);
  });

  it('logs stop_failed and cleans up when the Profiler.stop WIRE call throws (Error)', () => {
    // post('Profiler.stop') throws synchronously → stopProfiling's OUTER try/catch:
    // warns stop_failed + cleans up. No .cpuprofile is written.
    const flags = h.installSyncFakeSession({ throwOnStopPost: 'error' });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    startProfiling(scope, 'fit');
    expect(h.readdirHasLabels()).toBe(true);

    expect(() => stopProfiling(scope)).not.toThrow();
    expect(h.readdirHasCpuprofile()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.profiling.stop_failed',
        error: 'stop wire fault',
      }),
    );
    // The catch arm still ran cleanup (disconnect attempted).
    expect(flags.disconnected).toBe(true);
  });

  it('stringifies a non-Error wire fault in the stop catch (ternary else arm)', () => {
    // A string throw drives `error instanceof Error ? error.message : String(error)`
    // down its else branch.
    h.installSyncFakeSession({ throwOnStopPost: 'non-error' });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    startProfiling(scope, 'fit');
    expect(() => stopProfiling(scope)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.profiling.stop_failed',
        error: 'stop wire string fault',
      }),
    );
  });

  it('stringifies a non-Error connect fault in the start catch (start_failed else arm)', () => {
    // connect() throws a string → startProfiling's catch takes the
    // `error instanceof Error ? error.message : String(error)` else.
    h.installSyncFakeSession({ throwOnConnect: 'non-error' });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(() => startProfiling(scope, 'fit')).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.profiling.start_failed',
        error: 'connect string boom',
      }),
    );
  });

  it('returns early on the per-state isProfiling guard when the global active is clear', () => {
    // Reach `if (state.isProfiling) return;` (the PER-STATE guard) rather than the
    // global active-state guard: seed a scope whose own profiling state is already
    // `isProfiling: true` while `activeProfilingState` is null (reset in beforeEach).
    // The global guard falls through (active is null), and the per-state guard fires.
    h.installSyncFakeSession({ profile: { nodes: [] } });
    const alreadyProfiling = {
      session: null,
      isProfiling: true,
      profilePath: null,
      labelsPath: null,
    };
    const seeded = {
      runId: 'RUN_ALREADY',
      projectContext: { scope: 'project', projectRoot: h.tmp() },
      telemetry: { profiling: alreadyProfiling },
    } as unknown as RunScope;

    startProfiling(seeded, 'fit'); // state.isProfiling === true ⇒ early return
    // No artifacts written: the per-state guard short-circuited before connect.
    expect(h.readdir()).toHaveLength(0);
    expect(alreadyProfiling.session).toBeNull();
  });

  it('defaults the command labels when no command is supplied (the `?? cli`/`?? unknown` arms)', () => {
    // command === undefined drives `(command ?? 'cli')` for the filename and
    // `command ?? 'unknown'` for the labels payload.
    h.installSyncFakeSession({ profile: { nodes: [] } });

    startProfiling(scope); // no command argument ⇒ the `?? 'cli'` / `?? 'unknown'` fallbacks
    expect(h.readdirHasLabels()).toBe(true);
    const labels = JSON.parse(readFileSync(h.labelsFile(), 'utf8')) as Record<string, unknown>;
    expect(labels.command).toBe('unknown');
    // The safeCommand fell back to 'cli' in the artifact filename.
    expect(h.readdir().some((f) => f.includes('-cli-RUN_PROF_1.'))).toBe(true);
  });

  it('uses String(err) when the Profiler.stop callback error has a falsy message', () => {
    // An Error whose `message` is blanked drives `err.message || String(err)` down
    // its `|| String(err)` arm.
    const blankError = new Error('placeholder');
    blankError.message = '';
    h.installSyncFakeSession({ stopError: blankError });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    startProfiling(scope, 'fit');
    stopProfiling(scope);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.profiling.stop_failed',
        error: String(blankError),
      }),
    );
  });

  it('resetProfilingForTests cleans up an ACTIVE profile (the activeProfilingState arm)', () => {
    // Start (leaving activeProfilingState set) then reset WITHOUT stopping, so
    // `if (activeProfilingState !== null) cleanup(activeProfilingState)` takes its
    // true arm.
    const flags = h.installSyncFakeSession({ profile: { nodes: [] } });

    startProfiling(scope, 'fit');
    expect(flags.connected).toBe(true);

    resetProfilingForTests();
    // The active profile was torn down (disconnect ran during cleanup) and a
    // subsequent stop is a safe no-op.
    expect(flags.disconnected).toBe(true);
    expect(() => stopProfiling(scope)).not.toThrow();
  });
});
