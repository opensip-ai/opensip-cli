/**
 * Profiling support — optional and severable (see observability-hardening plan).
 *
 * Gate: `OPENSIP_PROFILING=1|true` explicitly enables local CPU artifacts.
 * OpenTelemetry export remains independently gated by its OTLP endpoint, so a
 * local profile never requires a collector and an endpoint alone never creates
 * an expensive profile artifact.
 *
 * Implementation uses Node's built-in `inspector` module for real CPU profiles
 * (no extra published dependency for the optional profiling path). This gives
 * actionable .cpuprofile files for short-lived CLI runs, with runId/command
 * labels embedded in the filename and a sidecar JSON.
 *
 * When a full OTel profiles signal / Pyroscope client is desired, the start/stop
 * hooks here are the single place to swap in that implementation while reusing
 * the same resource attributes, runId, and shutdown discipline.
 *
 * The seam is intentionally thin in core; all heavy lifting and any future
 * SDK bits stay in the CLI root.
 */

import { Session } from 'node:inspector';
import { dirname, join, resolve } from 'node:path';

import { logger, resolveEphemeralProjectPaths, type RunScope } from '@opensip-cli/core';

import { hostEnv } from '../env/host-env-specs.js';

import {
  createProfileArtifactIndex,
  discardProfileArtifacts,
  discardProfileArtifactLabels,
  writeCpuProfileArtifact,
  writeProfileArtifactLabels,
  type ProfileArtifactMetadata,
} from './profile-artifact-index.js';

/**
 * The slice of `node:inspector`'s {@link Session} this module actually drives:
 * `connect`/`disconnect` plus the two `post` overloads we issue
 * (`Profiler.enable`/`Profiler.start` and `Profiler.stop`). Narrowing to this
 * interface lets {@link __setInspectorSessionFactoryForTests} inject a fake
 * whose `post` invokes the callback SYNCHRONOUSLY — so the inner
 * `Profiler.start`/`Profiler.stop` callback arms (label-sidecar write, profile
 * write, and their error branches) are exercised deterministically, independent
 * of the real V8 profiler's async callback timing. That timing is non-
 * deterministic under the coverage lane (the `@vitest/coverage-v8` provider
 * holds its own inspector session), which previously made this file's branch
 * coverage flaky. Production keeps the real `new Session()` factory verbatim.
 */
export interface InspectorSession {
  connect(): void;
  disconnect(): void;
  post(
    method: 'Profiler.enable' | 'Profiler.start',
    callback?: (err: Error | null, params?: unknown) => void,
  ): void;
  post(
    method: 'Profiler.stop',
    callback?: (err: Error | null, params: { profile?: unknown }) => void,
  ): void;
}

type InspectorSessionFactory = () => InspectorSession;

/** Production factory: a real Node inspector session (structurally an InspectorSession). */
const realInspectorSessionFactory: InspectorSessionFactory = () => new Session();

let inspectorSessionFactory: InspectorSessionFactory = realInspectorSessionFactory;

interface ProfilingState {
  session: InspectorSession | null;
  isProfiling: boolean;
  artifacts: ProfileArtifactMetadata | null;
  startPromise: Promise<ProfileArtifactMetadata | undefined> | null;
  stopPromise: Promise<ProfileArtifactMetadata | undefined> | null;
  revision: number;
}

function createProfilingState(): ProfilingState {
  return {
    session: null,
    isProfiling: false,
    artifacts: null,
    startPromise: null,
    stopPromise: null,
    revision: 0,
  };
}

function isProfilingState(value: unknown): value is ProfilingState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'session' in value &&
    'isProfiling' in value &&
    'artifacts' in value &&
    'startPromise' in value &&
    'stopPromise' in value &&
    'revision' in value
  );
}

function profilingStateFor(scope: RunScope | undefined): ProfilingState {
  if (scope === undefined) return fallbackProfilingState;
  const existing = scope.telemetry.profiling;
  if (isProfilingState(existing)) return existing;
  const created = createProfilingState();
  scope.telemetry.profiling = created;
  return created;
}

function profilingDirectory(scope: RunScope | undefined): {
  readonly baseDir: string;
  readonly containmentRoot: string;
} {
  const configured = hostEnv.get<string>('OPENSIP_PROFILE_DIR')?.trim();
  if (configured) {
    const baseDir = resolve(configured);
    return { baseDir, containmentRoot: dirname(baseDir) };
  }
  const project = scope?.projectContext;
  if (project?.scope === 'project') {
    return {
      baseDir: join(project.projectRoot, 'opensip-cli/.runtime/profiles'),
      containmentRoot: resolve(project.projectRoot),
    };
  }
  if (project?.scope === 'ephemeral') {
    const runtimeDir = resolveEphemeralProjectPaths(project.projectRoot).runtimeDir;
    return { baseDir: join(runtimeDir, 'profiles'), containmentRoot: runtimeDir };
  }
  return {
    baseDir: join(process.cwd(), 'opensip-cli/.runtime/profiles'),
    containmentRoot: process.cwd(),
  };
}

const fallbackProfilingState = createProfilingState();
// Node's inspector CPU profiler is process-global. State details live on the
// RunScope telemetry bag; this pointer lets shutdownTelemetry stop the active
// profile when it is invoked outside the original scope.
let activeProfilingState: ProfilingState | null = null;

/** Module tag for structured logging (also dedupes the sonarjs/no-duplicate-string occurrences). */
const MODULE = 'cli:telemetry';
export const PROFILING_INSPECTOR_TIMEOUT_MS = 5000;

/** Returns true only when local CPU profiling was explicitly requested. */
export function isProfilingEnabled(): boolean {
  const explicit = hostEnv.get<string>('OPENSIP_PROFILING')?.trim().toLowerCase();
  return explicit === '1' || explicit === 'true';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type InspectorReply<T> = (error: Error | null, result?: T) => void;

function postWithDeadline<T>(
  method: 'Profiler.enable' | 'Profiler.start' | 'Profiler.stop',
  dispatch: (reply: InspectorReply<T>) => void,
): Promise<T> {
  return new Promise((resolvePost, rejectPost) => {
    let settled = false;
    const settle = (error: unknown, result?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== null && error !== undefined) {
        rejectPost(error instanceof Error ? error : new Error(errorMessage(error)));
      } else resolvePost(result as T);
    };
    const timer = setTimeout(
      () =>
        settle(
          new Error(`${method} callback exceeded ${String(PROFILING_INSPECTOR_TIMEOUT_MS)}ms`),
        ),
      PROFILING_INSPECTOR_TIMEOUT_MS,
    );
    timer.unref();
    try {
      dispatch((error, result) => settle(error, result));
    } catch (error) {
      settle(error);
    }
  });
}

function postWithoutResult(
  session: InspectorSession,
  method: 'Profiler.enable' | 'Profiler.start',
): Promise<void> {
  return postWithDeadline<void>(method, (reply) => {
    session.post(method, (error) => reply(error));
  });
}

function postStop(session: InspectorSession): Promise<{ readonly profile?: unknown }> {
  return postWithDeadline('Profiler.stop', (reply) => {
    session.post('Profiler.stop', (error, result = {}) => reply(error, result));
  });
}

function discardLabelsBestEffort(artifacts: ProfileArtifactMetadata): void {
  try {
    discardProfileArtifactLabels(artifacts);
  } catch {
    // @swallow-ok partial profiling artifacts are best-effort cleanup only
  }
}

function discardPairBestEffort(artifacts: ProfileArtifactMetadata): void {
  try {
    discardProfileArtifacts(artifacts);
  } catch {
    // @swallow-ok completed profiling artifacts are best-effort cleanup only
  }
}

/**
 * Start CPU profiling for this invocation (if gate is open).
 * Must be called after RunScope is entered (so runId is available).
 * Safe to call multiple times (idempotent).
 */
export function startProfiling(
  scope?: RunScope,
  command?: string,
): Promise<ProfileArtifactMetadata | undefined> {
  if (!isProfilingEnabled()) return Promise.resolve(undefined);
  if (activeProfilingState?.isProfiling === true) {
    return (
      activeProfilingState.startPromise ??
      Promise.resolve(activeProfilingState.artifacts ?? undefined)
    );
  }
  const state = profilingStateFor(scope);
  if (state.isProfiling) {
    return state.startPromise ?? Promise.resolve(state.artifacts ?? undefined);
  }

  state.isProfiling = true;
  state.revision += 1;
  const revision = state.revision;
  activeProfilingState = state;
  const startPromise = (async (): Promise<ProfileArtifactMetadata | undefined> => {
    let reservedArtifacts: ProfileArtifactMetadata | undefined;
    try {
      const runId = scope?.runId ?? 'unknown';
      const profileDirectory = profilingDirectory(scope);
      const artifacts = createProfileArtifactIndex({
        ...profileDirectory,
        command: command ?? 'unknown',
        runId,
      });
      state.session = inspectorSessionFactory();
      // connect() is synchronous; void silences detached-promises in async start.
      void state.session.connect();
      await postWithoutResult(state.session, 'Profiler.enable');
      if (state.revision !== revision || !state.session) return undefined;

      // Reserve the sidecar before starting the expensive profiler. Exclusive
      // creation makes a collision or pre-existing symlink fail closed.
      // writeProfileArtifactLabels is synchronous; void silences detached-promises.
      void writeProfileArtifactLabels(artifacts);
      reservedArtifacts = artifacts;
      state.artifacts = artifacts;
      await postWithoutResult(state.session, 'Profiler.start');
      if (state.revision !== revision || !state.session) {
        discardLabelsBestEffort(artifacts);
        state.artifacts = null;
        return undefined;
      }

      logger.info({
        evt: 'cli.profiling.started',
        module: MODULE,
        runId: artifacts.labels.runId,
        command: artifacts.labels.command,
        profilePath: artifacts.profilePath,
        labelsPath: artifacts.labelsPath,
      });
      return artifacts;
    } catch (error) {
      logger.warn({
        evt: 'cli.profiling.start_failed',
        module: MODULE,
        error: errorMessage(error),
      });
      if (reservedArtifacts) {
        discardLabelsBestEffort(reservedArtifacts);
      }
      cleanup(state, false);
      return undefined;
    }
  })();
  state.startPromise = startPromise;
  return startPromise;
}

/**
 * Stop profiling and flush the .cpuprofile + labels sidecar.
 * Safe and idempotent.
 */
export function stopProfiling(scope?: RunScope): Promise<ProfileArtifactMetadata | undefined> {
  const scopedState = scope === undefined ? fallbackProfilingState : profilingStateFor(scope);
  // The inspector profiler is process-global. Prefer the active state even when
  // a caller supplies a different scope, so a concurrent/idempotent start cannot
  // strand the process-global profiler behind an idle scoped state.
  const state = activeProfilingState ?? scopedState;
  if (state.stopPromise) return state.stopPromise;
  if (!state.isProfiling) return Promise.resolve(state.artifacts ?? undefined);

  const stopPromise = (async (): Promise<ProfileArtifactMetadata | undefined> => {
    let completedArtifacts: ProfileArtifactMetadata | undefined;
    let profilePublished = false;
    try {
      await state.startPromise;
      if (!state.isProfiling || !state.session) return undefined;

      const result = await postStop(state.session);
      if (result.profile === undefined || !state.artifacts) {
        throw new Error('Profiler.stop returned no CPU profile');
      }
      completedArtifacts = writeCpuProfileArtifact(state.artifacts, result.profile);
      profilePublished = true;
      state.artifacts = completedArtifacts;
      logger.info({
        evt: 'cli.profiling.stopped',
        module: MODULE,
        profilePath: completedArtifacts.profilePath,
        labelsPath: completedArtifacts.labelsPath,
      });
    } catch (error) {
      logger.warn({
        evt: 'cli.profiling.stop_failed',
        module: MODULE,
        error: errorMessage(error),
      });
      if (state.artifacts) {
        if (profilePublished) discardPairBestEffort(state.artifacts);
        else discardLabelsBestEffort(state.artifacts);
      }
      completedArtifacts = undefined;
      state.artifacts = null;
    } finally {
      cleanup(state, completedArtifacts !== undefined);
    }
    return completedArtifacts;
  })();
  state.stopPromise = stopPromise;
  return stopPromise;
}

function cleanup(state: ProfilingState, retainArtifacts: boolean): void {
  if (state.session) {
    try {
      state.session.disconnect();
    } catch {
      // @swallow-ok best-effort inspector session disconnect during profiling teardown
    }
  }
  state.session = null;
  state.isProfiling = false;
  state.startPromise = null;
  state.stopPromise = null;
  state.revision += 1;
  if (!retainArtifacts) state.artifacts = null;
  if (activeProfilingState === state) activeProfilingState = null;
}

/** Exposed for tests / shutdown. */
export function resetProfilingForTests(): void {
  if (activeProfilingState !== null) cleanup(activeProfilingState, false);
  cleanup(fallbackProfilingState, false);
  inspectorSessionFactory = realInspectorSessionFactory;
}

/**
 * Test-only: swap the inspector-session factory so the start/stop callback
 * bodies can be driven deterministically (see {@link InspectorSession}). Pass
 * `undefined` to restore the real `new Session()` factory. Always restore in an
 * `afterEach` — {@link resetProfilingForTests} also restores it as a backstop.
 */
export function __setInspectorSessionFactoryForTests(
  factory: InspectorSessionFactory | undefined,
): void {
  inspectorSessionFactory = factory ?? realInspectorSessionFactory;
}
