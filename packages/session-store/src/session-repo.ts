import {
  SystemError,
  ValidationError,
  currentScope,
  extractPayloadVersion,
  isToolShortId,
  logger,
} from '@opensip-cli/core';
import {
  requireDrizzleDataStore,
  type DataStore,
  type DrizzleDataStore,
} from '@opensip-cli/datastore';
import { desc, eq, inArray, lt } from 'drizzle-orm';

import {
  sessionDashboardContributions,
  sessionHostMetrics,
  sessions,
  sessionToolPayload,
} from './schema/sessions.js';

import type { StoredSession, StoredSessionHostMetrics } from '@opensip-cli/contracts';
import type { ToolShortId } from '@opensip-cli/core';

const MODULE_NAME = 'session-store:session-repo';

/** Filters for {@link SessionRepo.list}: tool short-id and/or max row count. */
export interface SessionListOptions {
  readonly tool?: ToolShortId;
  readonly limit?: number;
}

/**
 * Persistence layer for tool-run sessions.
 *
 * Stores generic session columns plus one opaque per-tool `payload`
 * blob. This layer holds ZERO tool vocabulary — it never inspects or
 * validates the payload shape; the producing tool owns that. (Audit
 * 2026-05-29, session split.)
 */
export class SessionRepo {
  private readonly datastore: DrizzleDataStore;

  constructor(datastore: DataStore) {
    this.datastore = requireDrizzleDataStore(datastore);
  }

  /**
   * Persist a completed session row and its tool payload.
   *
   * Writes the generic columns including host-owned `startedAt` / `completedAt`
   * (mapped to the physical `timestamp*` / `completed_at*` columns). Any
   * `session.hostMetrics` is IGNORED here — host metrics arrive at different
   * times (persistMs after this write, egressMs after egress) and are attached
   * via the best-effort {@link SessionRepo.upsertHostMetrics} sibling upsert.
   *
   * @throws {ValidationError} When `startedAt` / `completedAt` are not finite
   *   dates — guarded eagerly so a bad value never corrupts the durable log.
   */
  save(session: StoredSession): void {
    try {
      // Validate timing eagerly so we never write NaN / "Invalid Date" into the
      // durable session log. A bad value from a tool (or replay path) becomes a
      // clear ValidationError instead of silent corruption that later surfaces
      // as confusing history / replay output.
      const startedMs = new Date(session.startedAt).getTime();
      const completedMs = new Date(session.completedAt).getTime();
      if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) {
        // @fitness-ignore-next-line result-pattern-consistency -- persistence boundary (DEC-015): invalid run timing is a write-time data-integrity guard the caller cannot recover from, so throw (not Result) is correct
        throw new ValidationError(
          `Invalid session timing for session ${session.id} (tool=${session.tool}): startedAt=${JSON.stringify(session.startedAt)} completedAt=${JSON.stringify(session.completedAt)}`,
          { code: 'VALIDATION.SESSION.INVALID_TIMESTAMP' },
        );
      }

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
            recipe: session.recipe ?? null,
            score: session.score,
            passed: session.passed,
            durationMs: session.durationMs,
          })
          .run();
        // Tool-owned opaque detail. Written when the caller supplies it;
        // `contracts` never inspects the shape.
        if (session.payload !== undefined) {
          const hasInnerVersion = extractPayloadVersion(session.payload) !== undefined;
          if (!hasInnerVersion) {
            // Deprecation-style warning for transition: encourage tools to adopt the
            // __version convention on new writes (per payload evolution rules).
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
      const results: StoredSession[] = [];
      for (const row of sessionRows) {
        results.push(this.hydrateSession(row));
      }
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
    const rows = this.datastore.db.select({ id: sessions.id }).from(sessions).all();
    return rows.length;
  }

  /** Delete sessions older than the given Date. Returns affected rowcount. */
  purge(before: Date): number {
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
  }

  /** Delete every session. Returns affected rowcount. */
  clearAll(): number {
    const removed = this.datastore.db.delete(sessions).run();
    logger.info({
      evt: 'session.clear.complete',
      module: MODULE_NAME,
      msg: 'Cleared all sessions',
      deleted: removed.changes,
    });
    return removed.changes;
  }

  /**
   * Delete ONE tool's sessions (`tools data purge`, ADR-0042). Associated
   * `session_tool_payload` rows go via the schema's `onDelete: 'cascade'` FK
   * (the sqlite backend runs `PRAGMA foreign_keys = ON`). Returns the deleted
   * session count.
   */
  clearForTool(toolId: string): number {
    const removed = this.datastore.db.delete(sessions).where(eq(sessions.tool, toolId)).run();
    logger.info({
      evt: 'session.clear_for_tool.complete',
      module: MODULE_NAME,
      msg: 'Cleared sessions for tool',
      tool: toolId,
      deleted: removed.changes,
    });
    return removed.changes;
  }

  private hydrateSession(row: typeof sessions.$inferSelect): StoredSession {
    // Validate row.tool against the documented union — the SQLite column
    // is plain text with no CHECK constraint, so a legacy or hand-edited
    // row could carry a value outside the type. Casting blindly would
    // silently misroute downstream consumers that branch on `tool`.
    if (!isToolShortId(row.tool)) {
      throw new SystemError(
        `Session ${row.id} has unknown tool value: ${JSON.stringify(row.tool)}`,
        { code: 'SYSTEM.DATA.UNKNOWN_TOOL' },
      );
    }
    // Tool-owned opaque detail. drizzle returns the JSON column already
    // parsed; contracts does not inspect or validate the shape — that is
    // the owning tool's responsibility.
    const payloadRow = this.datastore.db
      .select({
        payload: sessionToolPayload.payload,
        payload_version: sessionToolPayload.payload_version,
      })
      .from(sessionToolPayload)
      .where(eq(sessionToolPayload.sessionId, row.id))
      .get();

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

      // Emit on the per-run DiagnosticsBus for --json / CommandOutcome consumers (cross-cutting observability).
      // Uses currentScope per RunScope rules; safe no-op when no scope (e.g. some tests).
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
    const hostMetrics = this.readHostMetrics(row.id);

    return {
      id: row.id,
      tool: row.tool,
      startedAt,
      completedAt,
      cwd: row.cwd,
      recipe: row.recipe ?? undefined,
      score: row.score,
      passed: row.passed,
      durationMs: row.durationMs,
      ...(hostMetrics ? { hostMetrics } : {}),
      payload: payloadRow?.payload,
    };
  }

  /**
   * Read the sibling host-metrics record for a session, or `undefined` when no
   * metrics row exists. Null columns are dropped so the projection only carries
   * metrics that were actually captured.
   */
  private readHostMetrics(sessionId: string): StoredSessionHostMetrics | undefined {
    const row = this.datastore.db
      .select()
      .from(sessionHostMetrics)
      .where(eq(sessionHostMetrics.sessionId, sessionId))
      .get();
    if (!row) return undefined;
    const metrics: Record<string, number> = {};
    if (row.ttyBusyMs != null) metrics.ttyBusyMs = row.ttyBusyMs;
    if (row.renderMs != null) metrics.renderMs = row.renderMs;
    if (row.persistMs != null) metrics.persistMs = row.persistMs;
    if (row.egressMs != null) metrics.egressMs = row.egressMs;
    if (row.totalCommandMs != null) metrics.totalCommandMs = row.totalCommandMs;
    return Object.keys(metrics).length > 0 ? metrics : undefined;
  }

  /**
   * Best-effort upsert of host-side overhead metrics for a session
   * (host-owned-run-timing §5.3). Called by the host run plane as render /
   * persist / egress metrics become known; only the provided (non-undefined)
   * fields are written, merging onto any existing row. Never throws — metrics
   * are observability, not correctness.
   */
  upsertHostMetrics(sessionId: string, metrics: StoredSessionHostMetrics): void {
    try {
      // `set` keys are the Drizzle COLUMN PROPERTY names (camelCase), NOT the
      // SQL column names — Drizzle silently ignores unknown keys, so snake_case
      // here would no-op the ON CONFLICT update and the merge would be lost.
      const patch: Partial<typeof sessionHostMetrics.$inferInsert> = {};
      if (metrics.ttyBusyMs !== undefined) patch.ttyBusyMs = metrics.ttyBusyMs;
      if (metrics.renderMs !== undefined) patch.renderMs = metrics.renderMs;
      if (metrics.persistMs !== undefined) patch.persistMs = metrics.persistMs;
      if (metrics.egressMs !== undefined) patch.egressMs = metrics.egressMs;
      if (metrics.totalCommandMs !== undefined) patch.totalCommandMs = metrics.totalCommandMs;
      if (Object.keys(patch).length === 0) return;
      this.datastore.db
        .insert(sessionHostMetrics)
        .values({
          sessionId,
          ttyBusyMs: metrics.ttyBusyMs ?? null,
          renderMs: metrics.renderMs ?? null,
          persistMs: metrics.persistMs ?? null,
          egressMs: metrics.egressMs ?? null,
          totalCommandMs: metrics.totalCommandMs ?? null,
        })
        .onConflictDoUpdate({ target: sessionHostMetrics.sessionId, set: patch })
        .run();
    } catch (error) {
      logger.warn({
        evt: 'session.host_metrics.upsert_failed',
        module: MODULE_NAME,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Best-effort save of a tool's opaque per-run dashboard contribution
   * (host-owned-run-timing §7), keyed by (session id, tool). Replaces any
   * prior contribution for the same pair. The persistence layer holds zero
   * tool vocabulary — `contribution` is an opaque JSON blob. Never throws.
   */
  saveDashboardContribution(sessionId: string, tool: ToolShortId, contribution: unknown): void {
    try {
      this.datastore.db
        .insert(sessionDashboardContributions)
        .values({ sessionId, tool, contribution, version: 1 })
        .onConflictDoUpdate({
          target: [sessionDashboardContributions.sessionId, sessionDashboardContributions.tool],
          set: { contribution, version: 1 },
        })
        .run();
    } catch (error) {
      logger.warn({
        evt: 'session.dashboard_contribution.save_failed',
        module: MODULE_NAME,
        sessionId,
        tool,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Load durable dashboard contributions for the given session ids (report
   * composition path). Returns one entry per stored (session id, tool) row
   * with the opaque contribution blob the producing tool wrote.
   */
  listDashboardContributions(sessionIds: readonly string[]): readonly {
    readonly sessionId: string;
    readonly tool: ToolShortId;
    readonly contribution: unknown;
  }[] {
    if (sessionIds.length === 0) return [];
    const rows = this.datastore.db
      .select()
      .from(sessionDashboardContributions)
      .where(inArray(sessionDashboardContributions.sessionId, [...sessionIds]))
      .all();
    const out: { sessionId: string; tool: ToolShortId; contribution: unknown }[] = [];
    for (const row of rows) {
      if (!isToolShortId(row.tool)) continue;
      out.push({ sessionId: row.sessionId, tool: row.tool, contribution: row.contribution });
    }
    return out;
  }
}
