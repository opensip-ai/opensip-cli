import { SystemError, isToolShortId, logger } from '@opensip-cli/core';
import {
  requireDrizzleDataStore,
  type DataStore,
  type DrizzleDataStore,
} from '@opensip-cli/datastore';
import { desc, eq, lt } from 'drizzle-orm';

import { sessions, sessionToolPayload } from './schema/sessions.js';

import type { StoredSession } from '@opensip-cli/contracts';
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

  save(session: StoredSession): void {
    try {
      this.datastore.transaction((tx) => {
        tx.insert(sessions)
          .values({
            id: session.id,
            tool: session.tool,
            timestamp: new Date(session.timestamp).getTime(),
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
          tx.insert(sessionToolPayload)
            .values({
              sessionId: session.id,
              tool: session.tool,
              payload: session.payload,
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
      .select({ payload: sessionToolPayload.payload })
      .from(sessionToolPayload)
      .where(eq(sessionToolPayload.sessionId, row.id))
      .get();
    return {
      id: row.id,
      tool: row.tool,
      timestamp: new Date(row.timestamp).toISOString(),
      cwd: row.cwd,
      recipe: row.recipe ?? undefined,
      score: row.score,
      passed: row.passed,
      durationMs: row.durationMs,
      payload: payloadRow?.payload,
    };
  }
}
