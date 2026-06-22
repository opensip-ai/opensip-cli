/**
 * Shared in-process test harness for the optional CPU-profiling unit suites
 * (ADR-0049). Both `profiling.test.ts` (gate + idempotency) and
 * `profiling-callback-arms.test.ts` (the synchronous fake-session callback arms)
 * build on this so neither file re-declares the env save/restore lifecycle, the
 * temp profiles-dir helpers, or the synchronous fake inspector session.
 *
 * `createProfilingHarness()` registers its OWN `beforeEach`/`afterEach` (env
 * isolation, a fresh temp dir, profiling-state + factory reset) and returns
 * accessors bound to the current test's temp dir.
 *
 * IMPORTANT — coverage determinism: every profiling test that opens the gate MUST
 * install {@link ProfilingHarness.installSyncFakeSession}. A test that calls
 * `startProfiling` under an open gate WITHOUT a fake falls through to the REAL
 * `node:inspector` Session, whose process-global, inspector-based profiler
 * corrupts `@vitest/coverage-v8`'s precise-coverage counters for profiling.ts
 * (the fake-session callback arms get intermittently dropped, flickering the cli
 * package below its branch floor). The genuine real-inspector wiring is proven
 * out-of-process in the sibling `profiling-real-inspector.e2e.test.ts`.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, vi } from 'vitest';

import {
  __setInspectorSessionFactoryForTests,
  resetProfilingForTests,
  type InspectorSession,
} from '../../profiling.js';

import type { RunScope } from '@opensip-cli/core';

export const ENDPOINT = 'OTEL_EXPORTER_OTLP_ENDPOINT';
export const GATE = 'OPENSIP_PROFILING';

export interface FakeSessionOptions {
  /** Profile payload delivered to the Profiler.stop callback (undefined ⇒ none). */
  readonly profile?: unknown;
  /** Error delivered to the Profiler.stop callback (exercises the err arm). */
  readonly stopError?: Error;
  /**
   * Throw from connect() to exercise startProfiling's catch + cleanup. `true` (or
   * `'error'`) throws an Error (the `.message` arm); `'non-error'` throws a string
   * so the catch's `error instanceof Error ? error.message : String(error)`
   * ternary takes its else.
   */
  readonly throwOnConnect?: boolean | 'error' | 'non-error';
  /** Throw from disconnect() to exercise cleanup's swallow-ok arm. */
  readonly throwOnDisconnect?: boolean;
  /**
   * Throw SYNCHRONOUSLY from `post('Profiler.stop')` (before its callback runs)
   * to exercise stopProfiling's outer try/catch — the only arm reachable when
   * the wire call itself faults. A non-Error throw (string) drives the
   * `error instanceof Error ? error.message : String(error)` ternary's else.
   */
  readonly throwOnStopPost?: 'error' | 'non-error';
}

export interface ProfilingHarness {
  /** A project-scoped RunScope (runId RUN_PROF_1) bound to the current temp dir. */
  readonly scopeFor: () => RunScope;
  /** Absolute path to the current test's profiles output dir. */
  readonly profilesDir: () => string;
  /** Whether the profiles dir exists yet. */
  readonly profilesDirExists: () => boolean;
  /** All artifact filenames currently in the profiles dir (empty if none). */
  readonly readdir: () => string[];
  readonly readdirHasLabels: () => boolean;
  readonly readdirHasCpuprofile: () => boolean;
  /** Absolute path to the (single) labels sidecar — throws if absent. */
  readonly labelsFile: () => string;
  /** The current test's temp dir (re-created per test). */
  readonly tmp: () => string;
  /**
   * Install a SYNCHRONOUS fake inspector session whose `post()` invokes callbacks
   * inline (see the module note on why the real session must never run here).
   */
  readonly installSyncFakeSession: (opts?: FakeSessionOptions) => {
    connected: boolean;
    disconnected: boolean;
  };
}

/**
 * Build a profiling test harness and register its lifecycle hooks. Call once at
 * the top of a `describe`-less module scope (vitest hooks attach to the current
 * file's suite). Saves/restores the two gate env vars, mints a fresh temp dir per
 * test, and resets profiling state + the injected session factory around each.
 */
export function createProfilingHarness(): ProfilingHarness {
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
    // Restore the real session factory through the documented restore path
    // (passing `undefined`), not only via resetProfilingForTests's internal
    // assignment — this is the canonical teardown the public seam advertises.
    __setInspectorSessionFactoryForTests(undefined);
    vi.restoreAllMocks();
    for (const k of [ENDPOINT, GATE]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  const profilesDir = (): string => join(tmp, 'opensip-cli/.runtime/profiles');
  const readdir = (): string[] => {
    try {
      return readdirSync(profilesDir());
    } catch {
      return [];
    }
  };

  return {
    tmp: () => tmp,
    scopeFor: () =>
      ({
        runId: 'RUN_PROF_1',
        projectContext: { scope: 'project', projectRoot: tmp },
        telemetry: {},
      }) as unknown as RunScope,
    profilesDir,
    profilesDirExists: () => existsSync(profilesDir()),
    readdir,
    readdirHasLabels: () => readdir().some((f) => f.endsWith('.labels.json')),
    readdirHasCpuprofile: () => readdir().some((f) => f.endsWith('.cpuprofile')),
    labelsFile: () => {
      const f = readdir().find((x) => x.endsWith('.labels.json'));
      if (!f) throw new Error('no labels file');
      return join(profilesDir(), f);
    },
    installSyncFakeSession: (opts: FakeSessionOptions = {}) => {
      const flags = { connected: false, disconnected: false };
      const fake: InspectorSession = {
        connect() {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error throw: drives startProfiling's `error instanceof Error ? … : String(error)` else arm.
          if (opts.throwOnConnect === 'non-error') throw 'connect string boom';
          if (opts.throwOnConnect) throw new Error('connect boom');
          flags.connected = true;
        },
        disconnect() {
          flags.disconnected = true;
          if (opts.throwOnDisconnect) throw new Error('disconnect boom');
        },
        post(method: string, callback?: (err: Error | null, params?: unknown) => void): void {
          if (method === 'Profiler.stop' && opts.throwOnStopPost !== undefined) {
            // The wire call faults BEFORE invoking the callback — the only way to
            // reach stopProfiling's outer try/catch. A string throw drives the
            // catch's `String(error)` else; an Error drives the `.message` arm.
            if (opts.throwOnStopPost === 'non-error') {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error throw: exercises the `String(error)` else arm of the stop catch.
              throw 'stop wire string fault';
            }
            throw new Error('stop wire fault');
          }
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
    },
  };
}
