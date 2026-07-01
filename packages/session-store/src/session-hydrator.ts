import {
  SystemError,
  currentScope,
  extractPayloadVersion,
  isToolShortId,
  logger,
  type ToolRunOutcome,
} from '@opensip-cli/core';

import { type sessions } from './schema/sessions.js';

import type { StoredSession, StoredSessionHostMetrics } from '@opensip-cli/contracts';

const MODULE_NAME = 'session-store:session-repo';

const RUN_OUTCOMES = new Set<ToolRunOutcome>(['passed', 'failed', 'degraded', 'error']);

function normalizeRunOutcome(stored: string | null | undefined): ToolRunOutcome | undefined {
  if (stored !== null && stored !== undefined && RUN_OUTCOMES.has(stored as ToolRunOutcome)) {
    return stored as ToolRunOutcome;
  }
  return undefined;
}

export interface StoredPayloadRow {
  readonly payload: unknown;
  readonly payload_version: number | null;
}

/**
 * Assemble a StoredSession from its base row + already-fetched payload and
 * host-metrics. Shared by the single-row hydrate and batch list paths.
 */
export function buildSession(
  row: typeof sessions.$inferSelect,
  payloadRow: StoredPayloadRow | undefined,
  hostMetrics: StoredSessionHostMetrics | undefined,
): StoredSession {
  // SHAPE-only guard (M3): the tool-vocabulary-free store validates the open
  // `ToolShortId` is a non-empty string, NOT closed membership (host's job; parity).
  if (!isToolShortId(row.tool)) {
    throw new SystemError(
      `Session ${row.id} has an invalid tool value: ${JSON.stringify(row.tool)}`,
      { code: 'SYSTEM.DATA.UNKNOWN_TOOL' },
    );
  }

  const outerVersion = payloadRow?.payload_version ?? 1;
  const innerVersion = extractPayloadVersion(payloadRow?.payload);

  if (outerVersion > 1 || (innerVersion !== undefined && innerVersion > 1)) {
    logger.warn({
      evt: 'session.payload.future_version',
      module: MODULE_NAME,
      sessionId: row.id,
      outerVersion,
      innerVersion: innerVersion ?? null,
      msg: 'Payload schema version newer than this CLI knows; treating as opaque (may lose fields on display).',
    });

    // Mirror to the per-run DiagnosticsBus for --json consumers (no-op without a scope).
    const scope = currentScope();
    scope?.diagnostics?.event(
      'load',
      'warn',
      `session payload future version (outer=${outerVersion}, inner=${innerVersion ?? 'legacy'})`,
      {
        sessionId: row.id,
        outerVersion,
        innerVersion: innerVersion ?? undefined,
      },
    );
  }

  const startedAt = row.timestamp_iso ?? new Date(row.timestamp).toISOString(); // prefer original for fidelity
  // completedAt: prefer the stored ISO, else the stored ms, else (legacy rows
  // written before completedAt existed) synthesize startedAt + durationMs.
  const completedAt =
    row.completed_at_iso ??
    (row.completed_at == null
      ? new Date(row.timestamp + row.durationMs).toISOString() // legacy synth
      : new Date(row.completed_at).toISOString());

  const passed = row.passed;
  const runOutcome = normalizeRunOutcome(row.run_outcome);

  return {
    id: row.id,
    tool: row.tool,
    startedAt,
    completedAt,
    cwd: row.cwd,
    ...(row.suite_run_id === null || row.suite_run_id === undefined
      ? {}
      : { suiteRunId: row.suite_run_id }),
    ...(row.suite_name === null || row.suite_name === undefined
      ? {}
      : { suiteName: row.suite_name }),
    recipe: row.recipe ?? undefined,
    score: row.score,
    passed,
    ...(runOutcome === undefined ? {} : { runOutcome }),
    durationMs: row.durationMs,
    ...(hostMetrics ? { hostMetrics } : {}),
    payload: payloadRow?.payload,
  };
}
