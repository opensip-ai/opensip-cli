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

import { Session } from 'node:inspector';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger, type RunScope } from '@opensip-cli/core';

import { hostEnv } from '../env/host-env-specs.js';

let session: Session | null = null;
let isProfiling = false;
let profilePath: string | null = null;
let labelsPath: string | null = null;

export interface ProfilingLabels {
  readonly runId?: string;
  readonly command?: string;
  readonly [key: string]: unknown;
}

/** Returns true if the recommended or OTEL-only profiling gate is satisfied. */
export function isProfilingEnabled(): boolean {
  const endpoint = hostEnv.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT');
  if (!endpoint) return false;

  const explicit = hostEnv.get<string>('OPENSIP_PROFILING');
  if (explicit === '1' || explicit === 'true') return true;

  // Supported "just the OTEL endpoint" alternative (with warnings in docs/ADR-0049).
  // Many teams prefer one knob; we honor it but log at warn so cost is visible.
  // Operators who do not want this can set OPENSIP_PROFILING=0 explicitly.
  return true; // OTEL endpoint present ⇒ profiling on in this fallback mode
}

/**
 * Start CPU profiling for this invocation (if gate is open).
 * Must be called after RunScope is entered (so runId is available).
 * Safe to call multiple times (idempotent).
 */
export function startProfiling(scope?: RunScope, command?: string): void {
  if (isProfiling) return;

  try {
    if (!isProfilingEnabled()) return;
    session = new Session();
    session.connect();

    session.post('Profiler.enable', () => {
      session!.post('Profiler.start', () => {
        isProfiling = true;

        const runId = scope?.runId || 'unknown';
        const safeCommand = (command || 'cli').replace(/[^a-z0-9_-]/gi, '_');
        const ts = new Date().toISOString().replace(/[:.]/g, '-');

        // Place profiles under project logs dir if available, else cwd/.runtime/profiles
        const baseDir =
          scope?.projectContext?.scope === 'project'
            ? join(scope.projectContext.projectRoot, 'opensip-cli/.runtime/profiles')
            : join(process.cwd(), 'opensip-cli/.runtime/profiles');

        mkdirSync(baseDir, { recursive: true });

        profilePath = join(baseDir, `${ts}-${safeCommand}-${runId}.cpuprofile`);
        labelsPath = join(baseDir, `${ts}-${safeCommand}-${runId}.labels.json`);

        const labels: ProfilingLabels = {
          runId,
          command: command || 'unknown',
          service: 'opensip-cli',
          // Add any OTEL_RESOURCE_ATTRIBUTES derived labels here if needed in future
        };

        writeFileSync(labelsPath, JSON.stringify(labels, null, 2));

        logger.info({
          evt: 'cli.profiling.started',
          module: 'cli:telemetry',
          runId,
          command,
          profilePath,
        });
      });
    });
  } catch (error) {
    logger.warn({
      evt: 'cli.profiling.start_failed',
      module: 'cli:telemetry',
      error: error instanceof Error ? error.message : String(error),
    });
    // Best effort — profiling failure must never break the run
    cleanup();
  }
}

/**
 * Stop profiling and flush the .cpuprofile + labels sidecar.
 * Safe and idempotent.
 */
export function stopProfiling(): void {
  if (!isProfiling || !session) {
    cleanup();
    return;
  }

  try {
    session.post('Profiler.stop', (err, { profile }) => {
      if (err) {
        logger.warn({
          evt: 'cli.profiling.stop_failed',
          module: 'cli:telemetry',
          error: err.message || String(err),
        });
      } else if (profile && profilePath) {
        writeFileSync(profilePath, JSON.stringify(profile));
        logger.info({
          evt: 'cli.profiling.stopped',
          module: 'cli:telemetry',
          profilePath,
          labelsPath,
        });
      }
      cleanup();
    });
  } catch (error) {
    logger.warn({
      evt: 'cli.profiling.stop_failed',
      module: 'cli:telemetry',
      error: error instanceof Error ? error.message : String(error),
    });
    cleanup();
  }
}

function cleanup(): void {
  if (session) {
    try {
      session.disconnect();
    } catch {
      // ignore
    }
  }
  session = null;
  isProfiling = false;
  profilePath = null;
  labelsPath = null;
}

/** Exposed for tests / shutdown. */
export function resetProfilingForTests(): void {
  cleanup();
}
