import {
  SystemError,
  ValidationError,
  currentScope,
  extractPayloadVersion,
  isToolShortId,
  logger,
  type ToolRunOutcome,
  type ToolShortId,
} from '@opensip-cli/core';
import {
  requireDrizzleDataStore,
  type DataStore,
  type DrizzleDataStore,
} from '@opensip-cli/datastore';
import { count, desc, eq, inArray, lt, notInArray } from 'drizzle-orm';

import { sessions, sessionToolPayload } from './schema/sessions.js';
import {
  hostMetricsBySessionId,
  readHostMetrics,
  upsertHostMetricsRow,
} from './session-repo-host-metrics.js';

import type { StoredSession, StoredSessionHostMetrics } from '@opensip-cli/contracts';

const MODULE_NAME = 'session-store:session-repo';

const RUN_OUTCOMES = new Set<ToolRunOutcome>(['passed', 'failed', 'degraded', 'error']);

function normalizeRunOutcome(stored: string | null | undefined): ToolRunOutcome | undefined {
  if (stored !== null && stored !== undefined && RUN_OUTCOMES.has(stored as ToolRunOutcome)) {
    return stored as ToolRunOutcome;
  }
  return undefined;
}

interface StoredPayloadRow {
  readonly payload: unknown;
  readonly payload_version: number | null;
}

/** Filters for {@link SessionRepo.list}: tool short-id and/or max row count. */
export interface SessionListOptions {
  readonly tool?: ToolShortId;
  readonly limit?: number;
}

/**
 * Persistence layer for tool-run sessions. Stores generic session columns plus
 * one opaque per-tool `payload` blob; holds ZERO tool vocabulary — it never
 * inspects/validates the payload shape (the producing tool owns that). (Audit
 * 2026-05-29, session split.)
 */
export class SessionRepo {
  private readonly datastore: DrizzleDataStore;

  // @yagni-ignore-next-line duplicate-body-candidate -- repository constructors intentionally share the same datastore narrowing idiom; a base class would add indirection without reducing behavior.
  constructor(datastore: DataStore) {
    this.datastore = requireDrizzleDataStore(datastore);
  }

  /**
   * Persist a completed session row and its tool payload. Writes the generic
   * columns including host-owned `startedAt` / `completedAt` (mapped to the
   * physical `timestamp*` / `completed_at*` columns); `session.hostMetrics` is
   * IGNORED here — metrics arrive later and attach via {@link SessionRepo.upsertHostMetrics}.
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

  list(opts: SessionListOptions = {}): readonly StoredSession[] {
    try {
      const baseQuery = opts.tool
        ? this.datastore.db.select().from(sessions).where(eq(sessions.tool, opts.tool))
        : this.datastore.db.select().from(sessions);
      const ordered = baseQuery.orderBy(desc(sessions.timestamp));
      const sessionRows = opts.limit ? ordered.limit(opts.limit).all() : ordered.all();

      const ids = sessionRows.map((row) => row.id);
      const payloadsById = this.payloadsBySessionId(ids);
      const metricsById = hostMetricsBySessionId(this.datastore, ids);
      const results = sessionRows.map((row) =>
        this.buildSession(row, payloadsById.get(row.id), metricsById.get(row.id)),
      );
      logger.info({
        evt: 'session.list.complete',
        module: MODULE_NAME,
        msg: 'Listed sessions',
        count: results.length,
      });
      return results;
    } catch (error) {
      logger.error({
        evt: 'session.list.error',
        module: MODULE_NAME,
        msg: 'Failed to list sessions',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  get(id: string): StoredSession | null {
    const row = this.datastore.db.select().from(sessions).where(eq(sessions.id, id)).get();
    return row ? this.hydrateSession(row) : null;
  }

  latest(opts: { tool?: ToolShortId } = {}): StoredSession | null {
    const rows = this.list({ ...opts, limit: 1 });
    return rows[0] ?? null;
  }

  count(): number {
    const row = this.datastore.db.select({ value: count() }).from(sessions).get();
    return row?.value ?? 0;
  }

  /**
   * Keep the newest `keep` sessions by start time and delete the rest.
   * `keep <= 0` disables count pruning. Foreign-key cascades remove sibling
   * host-metrics and payload rows.
   */
  pruneToCount(keep: number): number {
    if (!Number.isFinite(keep) || keep <= 0) return 0;
    const limit = Math.trunc(keep);
    return this.datastore.withWriteLock('session.prune_to_count', () => {
      try {
        const keepIds = this.datastore.db
          .select({ id: sessions.id })
          .from(sessions)
          .orderBy(desc(sessions.timestamp))
          .limit(limit)
          .all()
          .map((row) => row.id);
        if (keepIds.length === 0) return 0;
        const removed = this.datastore.db
          .delete(sessions)
          .where(notInArray(sessions.id, keepIds))
          .run();
        logger.info({
          evt: 'session.prune_to_count.complete',
          module: MODULE_NAME,
          msg: 'Pruned sessions to newest count',
          kept: keepIds.length,
          deleted: removed.changes,
        });
        return removed.changes;
      } catch (error) {
        logger.error({
          evt: 'session.prune_to_count.error',
          module: MODULE_NAME,
          msg: 'Failed to prune sessions to count',
          keep: limit,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  /** Delete sessions older than the given Date. Returns affected rowcount. */
  purge(before: Date): number {
    return this.datastore.withWriteLock('session.purge', () => {
      try {
        const cutoff = before.getTime();
        const removed = this.datastore.db
          .delete(sessions)
          .where(lt(sessions.timestamp, cutoff))
          .run();
        logger.info({
          evt: 'session.purge.complete',
          module: MODULE_NAME,
          msg: 'Purged sessions older than cutoff',
          cutoff: before.toISOString(),
          deleted: removed.changes,
        });
        return removed.changes;
      } catch (error) {
        logger.error({
          evt: 'session.purge.error',
          module: MODULE_NAME,
          msg: 'Failed to purge sessions',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  /** Delete every session. Returns affected rowcount. */
  clearAll(): number {
    return this.datastore.withWriteLock('session.clear', () => {
      const removed = this.datastore.db.delete(sessions).run();
      logger.info({
        evt: 'session.clear.complete',
        module: MODULE_NAME,
        msg: 'Cleared all sessions',
        deleted: removed.changes,
      });
      return removed.changes;
    });
  }

  /**
   * Delete ONE tool's sessions (`tools data purge`, ADR-0042). Associated
   * `session_tool_payload` rows go via the schema's `onDelete: 'cascade'` FK
   * (the sqlite backend runs `PRAGMA foreign_keys = ON`). Returns the deleted
   * session count.
   */
  clearForTool(toolId: string): number {
    return this.datastore.withWriteLock('session.clear_for_tool', () => {
      const removed = this.datastore.db.delete(sessions).where(eq(sessions.tool, toolId)).run();
      logger.info({
        evt: 'session.clear_for_tool.complete',
        module: MODULE_NAME,
        msg: 'Cleared sessions for tool',
        tool: toolId,
        deleted: removed.changes,
      });
      return removed.changes;
    });
  }

  /** Hydrate one session via point queries — the single-row get() path. */
  private hydrateSession(row: typeof sessions.$inferSelect): StoredSession {
    // Tool-owned opaque detail — drizzle returns the JSON pre-parsed; the owning
    // tool (not persistence) validates its shape.
    const payloadRow = this.datastore.db
      .select({
        payload: sessionToolPayload.payload,
        payload_version: sessionToolPayload.payload_version,
      })
      .from(sessionToolPayload)
      .where(eq(sessionToolPayload.sessionId, row.id))
      .get();
    return this.buildSession(row, payloadRow, readHostMetrics(this.datastore, row.id));
  }

  /** Batch-load tool payloads for a page of session ids (avoids list()'s N+1). */
  private payloadsBySessionId(ids: readonly string[]): Map<string, StoredPayloadRow> {
    const byId = new Map<string, StoredPayloadRow>();
    if (ids.length === 0) return byId;
    const rows = this.datastore.db
      .select({
        sessionId: sessionToolPayload.sessionId,
        payload: sessionToolPayload.payload,
        payload_version: sessionToolPayload.payload_version,
      })
      .from(sessionToolPayload)
      .where(inArray(sessionToolPayload.sessionId, ids))
      .all();
    for (const r of rows) {
      byId.set(r.sessionId, {
        payload: r.payload,
        payload_version: r.payload_version,
      });
    }
    return byId;
  }

  /**
   * Assemble a StoredSession from its base row + already-fetched payload and
   * host-metrics. Shared by the single-row hydrate and batch list paths.
   */
  private buildSession(
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

  /** Best-effort upsert of host-side overhead metrics (host-owned-run-timing §5.3). */
  upsertHostMetrics(sessionId: string, metrics: StoredSessionHostMetrics): void {
    this.datastore.withWriteLock('session.host_metrics.upsert', () => {
      upsertHostMetricsRow(this.datastore, sessionId, metrics);
    });
  }
}
