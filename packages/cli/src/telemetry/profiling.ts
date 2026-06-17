/**
 * Profiling support — optional and severable (see observability-hardening plan).
 *
 * Gate (per ADR-0049 and plan):
 * - Recommended: OPENSIP_PROFILING=1 AND OTEL_EXPORTER_OTLP_ENDPOINT set.
 * - Supported alternative (kept for flexibility): profiling can be tied to
 *   OTEL_EXPORTER_OTLP_ENDPOINT alone (documented with cost warnings).
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

import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { join } from 'node:path';

import { logger, type RunScope } from '@opensip-cli/core';

import { hostEnv } from '../env/host-env-specs.js';

interface ProfilingState {
  session: Session | null;
  isProfiling: boolean;
  profilePath: string | null;
  labelsPath: string | null;
}

function createProfilingState(): ProfilingState {
  return {
    session: null,
    isProfiling: false,
    profilePath: null,
    labelsPath: null,
  };
}

function isProfilingState(value: unknown): value is ProfilingState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'session' in value &&
    'isProfiling' in value &&
    'profilePath' in value &&
    'labelsPath' in value
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

const fallbackProfilingState = createProfilingState();
// Node's inspector CPU profiler is process-global. State details live on the
// RunScope telemetry bag; this pointer lets shutdownTelemetry stop the active
// profile when it is invoked outside the original scope.
let activeProfilingState: ProfilingState | null = null;
let warnedOtelOnlyProfiling = false;

/** Module tag for structured logging (also dedupes the sonarjs/no-duplicate-string occurrences). */
const MODULE = 'cli:telemetry';

export interface ProfilingLabels {
  readonly runId?: string;
  readonly command?: string;
  readonly [key: string]: unknown;
}

/** Returns true if the recommended or OTEL-only profiling gate is satisfied. */
export function isProfilingEnabled(): boolean {
  const endpoint = hostEnv.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT');
  if (!endpoint) return false;

  const explicit = hostEnv.get<string>('OPENSIP_PROFILING')?.toLowerCase();
  if (explicit === '0' || explicit === 'false') return false;
  if (explicit === '1' || explicit === 'true') return true;

  // Supported "just the OTEL endpoint" alternative (with warnings in docs/ADR-0049).
  // Many teams prefer one knob; we honor it but log at warn so cost is visible.
  // Operators who do not want this can set OPENSIP_PROFILING=0 explicitly.
  return true; // OTEL endpoint present ⇒ profiling on in this fallback mode
}

function warnIfOtelOnlyProfilingMode(): void {
  const endpoint = hostEnv.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT');
  const explicit = hostEnv.get<string>('OPENSIP_PROFILING');
  if (!endpoint || explicit !== undefined || warnedOtelOnlyProfiling) return;
  warnedOtelOnlyProfiling = true;
  logger.warn({
    evt: 'cli.profiling.otel_only_enabled',
    module: MODULE,
    msg:
      'CPU profiling is enabled because OTEL_EXPORTER_OTLP_ENDPOINT is set and ' +
      'OPENSIP_PROFILING is unset; set OPENSIP_PROFILING=0 to disable profile artifacts.',
  });
}

/**
 * Start CPU profiling for this invocation (if gate is open).
 * Must be called after RunScope is entered (so runId is available).
 * Safe to call multiple times (idempotent).
 */
export function startProfiling(scope?: RunScope, command?: string): void {
  if (activeProfilingState?.isProfiling === true) return;
  const state = profilingStateFor(scope);
  if (state.isProfiling) return;

  try {
    if (!isProfilingEnabled()) return;
    warnIfOtelOnlyProfilingMode();
    state.session = new Session();
    state.session.connect();
    state.isProfiling = true;
    activeProfilingState = state;

    state.session.post('Profiler.enable', (_err?: Error | null, _res?: unknown) => {
      if (!state.session) return;
      state.session.post('Profiler.start', (_err2?: Error | null, _res2?: unknown) => {
        if (!state.session) return;

        const runId = scope?.runId ?? 'unknown';
        const safeCommand = (command ?? 'cli').replace(/[^a-z0-9_-]/gi, '_');
        const ts = new Date().toISOString().replace(/[:.]/g, '-');

        // Place profiles under project logs dir if available, else cwd/.runtime/profiles
        const baseDir =
          scope?.projectContext?.scope === 'project'
            ? join(scope.projectContext.projectRoot, 'opensip-cli/.runtime/profiles')
            : join(process.cwd(), 'opensip-cli/.runtime/profiles');

        mkdirSync(baseDir, { recursive: true });

        state.profilePath = join(baseDir, `${ts}-${safeCommand}-${runId}.cpuprofile`);
        state.labelsPath = join(baseDir, `${ts}-${safeCommand}-${runId}.labels.json`);

        const labels: ProfilingLabels = {
          runId,
          command: command ?? 'unknown',
          service: 'opensip-cli',
          // Add any OTEL_RESOURCE_ATTRIBUTES derived labels here if needed in future
        };

        writeFileSync(state.labelsPath, JSON.stringify(labels, null, 2));

        logger.info({
          evt: 'cli.profiling.started',
          module: MODULE,
          runId,
          command,
          profilePath: state.profilePath,
        });
      });
    });
  } catch (error) {
    logger.warn({
      evt: 'cli.profiling.start_failed',
      module: MODULE,
      error: error instanceof Error ? error.message : String(error),
    });
    // Best effort — profiling failure must never break the run
    cleanup(state);
  }
}

/**
 * Stop profiling and flush the .cpuprofile + labels sidecar.
 * Safe and idempotent.
 */
export function stopProfiling(scope?: RunScope): void {
  const state =
    scope === undefined
      ? (activeProfilingState ?? fallbackProfilingState)
      : profilingStateFor(scope);
  if (!state.isProfiling || !state.session) {
    cleanup(state);
    return;
  }

  try {
    // node:inspector post callbacks for Profiler.* use structural types not fully declared
    // in the ambient types we consume; the result object (incl. profile) arrives as any.
    // We narrow locally for the write path; the disable is scoped to the wire call.
    state.session.post(
      'Profiler.stop',
      (err: Error | null | undefined, result: { profile?: unknown } = {}) => {
        if (err) {
          logger.warn({
            evt: 'cli.profiling.stop_failed',
            module: MODULE,
            error: err.message || String(err),
          });
        } else if (result.profile && state.profilePath) {
          writeFileSync(state.profilePath, JSON.stringify(result.profile));
          logger.info({
            evt: 'cli.profiling.stopped',
            module: MODULE,
            profilePath: state.profilePath,
            labelsPath: state.labelsPath,
          });
        }
        cleanup(state);
      },
    );
  } catch (error) {
    logger.warn({
      evt: 'cli.profiling.stop_failed',
      module: MODULE,
      error: error instanceof Error ? error.message : String(error),
    });
    cleanup(state);
  }
}

function cleanup(state: ProfilingState): void {
  if (state.session) {
    try {
      state.session.disconnect();
    } catch {
      // @swallow-ok best-effort inspector session disconnect during profiling teardown
    }
  }
  state.session = null;
  state.isProfiling = false;
  state.profilePath = null;
  state.labelsPath = null;
  if (activeProfilingState === state) activeProfilingState = null;
}

/** Exposed for tests / shutdown. */
export function resetProfilingForTests(): void {
  if (activeProfilingState !== null) cleanup(activeProfilingState);
  cleanup(fallbackProfilingState);
  warnedOtelOnlyProfiling = false;
}
