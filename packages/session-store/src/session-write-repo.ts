import { ValidationError, currentScope, extractPayloadVersion, logger } from '@opensip-cli/core';

import { sessions, sessionToolPayload } from './schema/sessions.js';
import { writeHostMetricsRowOrThrow } from './session-repo-host-metrics.js';
import {
  isFiniteNonNegativeNumber,
  isFiniteNumber,
  isJsonSerializable,
  isNonEmptyString,
  isOptionalString,
} from './write-shape-validation.js';

import type { StoredSession, StoredSessionHostMetrics } from '@opensip-cli/contracts';
import type { DrizzleDataStore, DrizzleHandle } from '@opensip-cli/datastore/internal';

const MODULE_NAME = 'session-store:session-repo';

/** Package-private validated projection shared by legacy and bundle writes. */
export interface PreparedSessionWrite {
  readonly sessionId: string;
  readonly tool: string;
  readonly hasPayload: boolean;
  readonly sessionRow: typeof sessions.$inferInsert;
  readonly payloadRow?: typeof sessionToolPayload.$inferInsert;
  readonly payloadMissingInnerVersion: boolean;
}

/**
 * Validate and project one fully host-stamped Session without writing it.
 *
 * This function is intentionally not exported from the package barrel. The
 * evidence-bundle writer uses it to prevalidate every row before entering its
 * transaction; `SessionWriteRepo` uses the same projection for legacy writes.
 */
export function prepareSessionWrite(session: StoredSession): PreparedSessionWrite {
  if (!sessionRowShapeIsValid(session)) {
    throw new ValidationError('Invalid required Session row shape.', {
      code: 'VALIDATION.SESSION.INVALID_SHAPE',
    });
  }
  const startedMs = new Date(session.startedAt).getTime();
  const completedMs = new Date(session.completedAt).getTime();
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) {
    throw new ValidationError(
      `Invalid session timing for session ${session.id} (tool=${session.tool}): startedAt=${JSON.stringify(session.startedAt)} completedAt=${JSON.stringify(session.completedAt)}`,
      { code: 'VALIDATION.SESSION.INVALID_TIMESTAMP' },
    );
  }

  const payloadRow =
    session.payload == null
      ? undefined
      : {
          sessionId: session.id,
          tool: session.tool,
          payload: session.payload,
          payload_version: 1,
        };

  return {
    sessionId: session.id,
    tool: session.tool,
    hasPayload: session.payload != null,
    sessionRow: {
      id: session.id,
      tool: session.tool,
      timestamp: startedMs,
      timestamp_iso: session.startedAt,
      completed_at: completedMs,
      completed_at_iso: session.completedAt,
      cwd: session.cwd,
      suite_run_id: session.suiteRunId ?? null,
      suite_name: session.suiteName ?? null,
      recipe: session.recipe ?? null,
      score: session.score,
      passed: session.passed,
      run_outcome: session.runOutcome ?? null,
      durationMs: session.durationMs,
      cli_version: session.cliVersion ?? null,
      engine_version: session.engineVersion ?? null,
    },
    ...(payloadRow === undefined ? {} : { payloadRow }),
    payloadMissingInnerVersion:
      session.payload != null && extractPayloadVersion(session.payload) === undefined,
  };
}

function sessionRowShapeIsValid(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return (
    isNonEmptyString(session.id) &&
    isNonEmptyString(session.tool) &&
    typeof session.startedAt === 'string' &&
    typeof session.completedAt === 'string' &&
    isNonEmptyString(session.cwd) &&
    isOptionalString(session.suiteRunId) &&
    isOptionalString(session.suiteName) &&
    isOptionalString(session.recipe) &&
    isFiniteNumber(session.score) &&
    typeof session.passed === 'boolean' &&
    (session.runOutcome === undefined ||
      session.runOutcome === 'passed' ||
      session.runOutcome === 'failed' ||
      session.runOutcome === 'degraded' ||
      session.runOutcome === 'error') &&
    isFiniteNonNegativeNumber(session.durationMs) &&
    isOptionalString(session.cliVersion) &&
    isOptionalString(session.engineVersion) &&
    (session.payload == null || isJsonSerializable(session.payload))
  );
}

/** Write a prepared Session and optional opaque payload through the active tx. */
export function writePreparedSession(tx: DrizzleHandle, prepared: PreparedSessionWrite): void {
  tx.insert(sessions).values(prepared.sessionRow).run();
  if (prepared.payloadRow !== undefined) {
    tx.insert(sessionToolPayload).values(prepared.payloadRow).run();
  }
}

/** Emit the existing bounded diagnostics only after the transaction committed. */
export function reportPreparedSessionWrite(prepared: PreparedSessionWrite): void {
  if (prepared.payloadMissingInnerVersion) {
    logger.warn({
      evt: 'session.payload.missing_version',
      module: MODULE_NAME,
      sessionId: prepared.sessionId,
      tool: prepared.tool,
      msg: "Tool wrote a session payload without top-level __version (treated as legacy v1). Update the tool's build*SessionPayload to include __version: 1.",
    });
    const scope = currentScope();
    scope?.diagnostics?.event(
      'persist',
      'warn',
      'session payload written without __version (legacy v1 treatment)',
      { sessionId: prepared.sessionId, tool: prepared.tool },
    );
  }
  logger.info({
    evt: 'session.save.complete',
    module: MODULE_NAME,
    msg: 'Session saved',
    sessionId: prepared.sessionId,
    tool: prepared.tool,
    hasPayload: prepared.hasPayload,
  });
}

export class SessionWriteRepo {
  constructor(private readonly datastore: DrizzleDataStore) {}

  /**
   * Persist a completed session row and its tool payload. Writes the generic
   * columns including host-owned `startedAt` / `completedAt` (mapped to the
   * physical `timestamp*` / `completed_at*` columns); `session.hostMetrics` is
   * IGNORED here — metrics arrive later and attach via {@link SessionWriteRepo.upsertHostMetrics}.
   *
   * @throws {ValidationError} When the mapped row shape or lifecycle timing is
   *   invalid — guarded eagerly so malformed values never reach the write lock.
   */
  save(session: StoredSession): void {
    try {
      const prepared = prepareSessionWrite(session);

      this.datastore.withWriteLock('session.save', () => {
        this.datastore.transaction((tx) => {
          writePreparedSession(tx, prepared);
        });
      });
      reportPreparedSessionWrite(prepared);
    } catch (error) {
      logger.error({
        evt: 'session.save.error',
        module: MODULE_NAME,
        msg: 'Failed to save session',
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      });
      throw error;
    }
  }

  /** Best-effort upsert of host-side overhead metrics (host-owned-run-timing §5.3). */
  upsertHostMetrics(sessionId: string, metrics: StoredSessionHostMetrics): void {
    try {
      this.datastore.withWriteLock('session.host_metrics.upsert', () => {
        writeHostMetricsRowOrThrow(this.datastore.db, sessionId, metrics);
      });
    } catch (error) {
      logger.warn({
        evt: 'session.host_metrics.upsert_failed',
        module: MODULE_NAME,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
