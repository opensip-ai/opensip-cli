import { ValidationError, currentScope, extractPayloadVersion, logger } from '@opensip-cli/core';

import { sessions, sessionToolPayload } from './schema/sessions.js';
import { upsertHostMetricsRow } from './session-repo-host-metrics.js';

import type { StoredSession, StoredSessionHostMetrics } from '@opensip-cli/contracts';
import type { DrizzleDataStore } from '@opensip-cli/datastore/internal';

const MODULE_NAME = 'session-store:session-repo';

export class SessionWriteRepo {
  constructor(private readonly datastore: DrizzleDataStore) {}

  /**
   * Persist a completed session row and its tool payload. Writes the generic
   * columns including host-owned `startedAt` / `completedAt` (mapped to the
   * physical `timestamp*` / `completed_at*` columns); `session.hostMetrics` is
   * IGNORED here — metrics arrive later and attach via {@link SessionWriteRepo.upsertHostMetrics}.
   *
   * @throws {ValidationError} When `startedAt` / `completedAt` are not finite
   *   dates — guarded eagerly so a bad value never corrupts the durable log.
   */
  save(session: StoredSession): void {
    try {
      const startedMs = new Date(session.startedAt).getTime();
      const completedMs = new Date(session.completedAt).getTime();
      if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) {
        throw new ValidationError(
          `Invalid session timing for session ${session.id} (tool=${session.tool}): startedAt=${JSON.stringify(session.startedAt)} completedAt=${JSON.stringify(session.completedAt)}`,
          { code: 'VALIDATION.SESSION.INVALID_TIMESTAMP' },
        );
      }

      this.datastore.withWriteLock('session.save', () => {
        this.datastore.transaction((tx) => {
          tx.insert(sessions)
            .values({
              id: session.id,
              tool: session.tool,
              timestamp: startedMs,
              timestamp_iso: session.startedAt, // preserve original for fidelity (avoids Date roundtrip loss of sub-ms/lexical form)
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
            })
            .run();
          if (session.payload !== undefined) {
            const hasInnerVersion = extractPayloadVersion(session.payload) !== undefined;
            if (!hasInnerVersion) {
              logger.warn({
                evt: 'session.payload.missing_version',
                module: MODULE_NAME,
                sessionId: session.id,
                tool: session.tool,
                msg: "Tool wrote a session payload without top-level __version (treated as legacy v1). Update the tool's build*SessionPayload to include __version: 1.",
              });
              const scope = currentScope();
              scope?.diagnostics?.event(
                'persist',
                'warn',
                'session payload written without __version (legacy v1 treatment)',
                { sessionId: session.id, tool: session.tool },
              );
            }

            tx.insert(sessionToolPayload)
              .values({
                sessionId: session.id,
                tool: session.tool,
                payload: session.payload,
                payload_version: 1, // outer storage contract version (inner __version lives inside the JSON blob)
              })
              .run();
          }
        });
      });
      logger.info({
        evt: 'session.save.complete',
        module: MODULE_NAME,
        msg: 'Session saved',
        sessionId: session.id,
        tool: session.tool,
        hasPayload: session.payload !== undefined,
      });
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
    this.datastore.withWriteLock('session.host_metrics.upsert', () => {
      upsertHostMetricsRow(this.datastore, sessionId, metrics);
    });
  }
}
