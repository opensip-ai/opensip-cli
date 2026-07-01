import { logger } from '@opensip-cli/core';
import { desc, eq, lt, notInArray } from 'drizzle-orm';

import { sessions } from './schema/sessions.js';

import type { DrizzleDataStore } from '@opensip-cli/datastore/internal';

const MODULE_NAME = 'session-store:session-repo';

export class SessionMaintenanceRepo {
  constructor(private readonly datastore: DrizzleDataStore) {}

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
}
