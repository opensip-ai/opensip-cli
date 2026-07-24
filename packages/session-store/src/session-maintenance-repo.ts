import { logger, ValidationError } from '@opensip-cli/core';
import { asc, count, eq, inArray, lt } from 'drizzle-orm';

import { sessions } from './schema/sessions.js';

import type { DrizzleDataStore } from '@opensip-cli/datastore/internal';

const MODULE_NAME = 'session-store:session-repo';

/** Hard ceiling for one bounded Session-retention transaction. */
export const MAX_SESSION_MAINTENANCE_BATCH_SIZE = 500;

/** Transactional bounded pruning operations for persisted Tool Sessions. */
export class SessionMaintenanceRepo {
  constructor(private readonly datastore: DrizzleDataStore) {}

  /**
   * Delete at most `batchSize` of the oldest sessions exceeding `keep`.
   *
   * Selection and deletion share one datastore write lock and SQLite
   * transaction. Equal timestamps are ordered by opaque Session ID so repeated
   * calls make deterministic progress without an unbounded ID query.
   */
  pruneToCountBatch(keep: number, batchSize: number = MAX_SESSION_MAINTENANCE_BATCH_SIZE): number {
    const boundedBatchSize = validateBatchSize(batchSize);
    if (!Number.isFinite(keep)) return 0;
    const limit = Math.trunc(keep);
    if (limit <= 0) return 0;
    return this.datastore.withWriteLock('session.prune_to_count_batch', () => {
      try {
        const removed = this.datastore.transaction((tx) => {
          const total = tx.select({ value: count() }).from(sessions).get()?.value ?? 0;
          const excess = Math.max(0, total - limit);
          const deleteLimit = Math.min(excess, boundedBatchSize);
          if (deleteLimit === 0) return 0;

          const deleteIds = tx
            .select({ id: sessions.id })
            .from(sessions)
            .orderBy(asc(sessions.timestamp), asc(sessions.id))
            .limit(deleteLimit)
            .all()
            .map((row) => row.id);
          if (deleteIds.length === 0) return 0;
          return tx.delete(sessions).where(inArray(sessions.id, deleteIds)).run().changes;
        });
        logger.info({
          evt: 'session.prune_to_count_batch.complete',
          module: MODULE_NAME,
          msg: 'Pruned one bounded batch of oldest sessions',
          keep: limit,
          batchSize: boundedBatchSize,
          deleted: removed,
        });
        return removed;
      } catch (error) {
        logger.error({
          evt: 'session.prune_to_count_batch.error',
          module: MODULE_NAME,
          msg: 'Failed to prune a bounded session batch',
          keep: limit,
          batchSize: boundedBatchSize,
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

  /**
   * Delete at most `batchSize` sessions older than `before`, oldest first.
   *
   * Selection and deletion share one datastore write lock and SQLite
   * transaction. Equal timestamps are ordered by opaque Session ID so repeated
   * calls make deterministic progress without an unbounded ID query.
   */
  purgeBatch(before: Date, batchSize: number = MAX_SESSION_MAINTENANCE_BATCH_SIZE): number {
    const cutoff = validateCutoff(before);
    const boundedBatchSize = validateBatchSize(batchSize);
    return this.datastore.withWriteLock('session.purge_batch', () => {
      try {
        const removed = this.datastore.transaction((tx) => {
          const deleteIds = tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(lt(sessions.timestamp, cutoff))
            .orderBy(asc(sessions.timestamp), asc(sessions.id))
            .limit(boundedBatchSize)
            .all()
            .map((row) => row.id);
          if (deleteIds.length === 0) return 0;
          return tx.delete(sessions).where(inArray(sessions.id, deleteIds)).run().changes;
        });
        logger.info({
          evt: 'session.purge_batch.complete',
          module: MODULE_NAME,
          msg: 'Purged one bounded batch of sessions older than cutoff',
          cutoff: before.toISOString(),
          batchSize: boundedBatchSize,
          deleted: removed,
        });
        return removed;
      } catch (error) {
        logger.error({
          evt: 'session.purge_batch.error',
          module: MODULE_NAME,
          msg: 'Failed to purge a bounded session batch',
          cutoff: before.toISOString(),
          batchSize: boundedBatchSize,
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

function validateBatchSize(batchSize: number): number {
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize <= 0 ||
    batchSize > MAX_SESSION_MAINTENANCE_BATCH_SIZE
  ) {
    throw new ValidationError(
      `Invalid Session maintenance batch size '${String(batchSize)}'. Must be a positive integer no greater than ${MAX_SESSION_MAINTENANCE_BATCH_SIZE}.`,
      { code: 'VALIDATION.SESSION.MAINTENANCE_BATCH_SIZE_INVALID' },
    );
  }
  return batchSize;
}

function validateCutoff(before: Date): number {
  if (!(before instanceof Date)) {
    throw new ValidationError('Invalid Session purge cutoff.', {
      code: 'VALIDATION.SESSION.PURGE_CUTOFF_INVALID',
    });
  }
  const cutoff = before.getTime();
  if (!Number.isFinite(cutoff)) {
    throw new ValidationError('Invalid Session purge cutoff.', {
      code: 'VALIDATION.SESSION.PURGE_CUTOFF_INVALID',
    });
  }
  return cutoff;
}
