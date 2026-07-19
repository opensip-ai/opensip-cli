import { and, asc, count, eq, exists, inArray, isNotNull, lt, notExists } from 'drizzle-orm';

import { runs, runSteps } from './schema/runs.js';

import type { DrizzleHandle } from '@opensip-cli/datastore/internal';

/** Hard ceiling for one bounded parent-Run retention transaction. */
export const MAX_RUN_RETENTION_BATCH_SIZE = 500;

/** Bounded outcome of one parent-Run retention transaction. */
export interface RunRetentionBatchResult {
  /** Rows inside the current count/age policy boundary before deletion. */
  readonly examined: number;
  /** Rows preserved because at least one RunStep still links a retained Session. */
  readonly protected: number;
  /** Unprotected parent Runs deleted by this bounded transaction. */
  readonly deleted: number;
  /** Eligible rows left for a later bounded batch. */
  readonly remainingEligible: number;
}

/** Shared immutable no-op outcome for disabled or empty retention passes. */
export const EMPTY_RUN_RETENTION_RESULT: RunRetentionBatchResult = Object.freeze({
  examined: 0,
  protected: 0,
  deleted: 0,
  remainingEligible: 0,
});

/** @throws {RangeError} When a retention batch size falls outside the bounded policy. */
export function requireRetentionBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RUN_RETENTION_BATCH_SIZE) {
    throw new RangeError(
      `Run retention batch size must be an integer between 1 and ${String(MAX_RUN_RETENTION_BATCH_SIZE)}.`,
    );
  }
  return value;
}

/** Count all persisted parent-Run rows inside the supplied transaction. */
export function countRunRows(tx: DrizzleHandle): number {
  return tx.select({ value: count() }).from(runs).get()?.value ?? 0;
}

/** Delete one bounded oldest-first batch outside the newest retained parent Runs. */
export function pruneCountExcessRunBatch(
  tx: DrizzleHandle,
  keep: number,
  batchSize: number,
): RunRetentionBatchResult {
  const examined = Math.max(0, countRunRows(tx) - keep);
  if (examined === 0) return EMPTY_RUN_RETENTION_RESULT;

  const candidates = tx
    .select({
      id: runs.id,
      completedAt: runs.completed_at,
    })
    .from(runs)
    .orderBy(asc(runs.completed_at), asc(runs.id))
    .limit(examined)
    .as('run_count_retention_candidates');
  const linkedStep = tx
    .select({ id: runSteps.id })
    .from(runSteps)
    .where(and(eq(runSteps.run_id, candidates.id), isNotNull(runSteps.session_id)));
  const protectedCount =
    tx.select({ value: count() }).from(candidates).where(exists(linkedStep)).get()?.value ?? 0;
  const ids = tx
    .select({ id: candidates.id })
    .from(candidates)
    .where(notExists(linkedStep))
    .orderBy(asc(candidates.completedAt), asc(candidates.id))
    .limit(batchSize)
    .all()
    .map((row) => row.id);
  return deleteRunRetentionCandidates(tx, ids, examined, protectedCount);
}

/** Delete one bounded oldest-first batch completed before the supplied cutoff. */
export function pruneAgedRunBatch(
  tx: DrizzleHandle,
  cutoff: number,
  batchSize: number,
): RunRetentionBatchResult {
  const examined =
    tx.select({ value: count() }).from(runs).where(lt(runs.completed_at, cutoff)).get()?.value ?? 0;
  if (examined === 0) return EMPTY_RUN_RETENTION_RESULT;

  const candidates = tx
    .select({
      id: runs.id,
      completedAt: runs.completed_at,
    })
    .from(runs)
    .where(lt(runs.completed_at, cutoff))
    .as('run_age_retention_candidates');
  const linkedStep = tx
    .select({ id: runSteps.id })
    .from(runSteps)
    .where(and(eq(runSteps.run_id, candidates.id), isNotNull(runSteps.session_id)));
  const protectedCount =
    tx.select({ value: count() }).from(candidates).where(exists(linkedStep)).get()?.value ?? 0;
  const ids = tx
    .select({ id: candidates.id })
    .from(candidates)
    .where(notExists(linkedStep))
    .orderBy(asc(candidates.completedAt), asc(candidates.id))
    .limit(batchSize)
    .all()
    .map((row) => row.id);
  return deleteRunRetentionCandidates(tx, ids, examined, protectedCount);
}

function deleteRunRetentionCandidates(
  tx: DrizzleHandle,
  ids: readonly string[],
  examined: number,
  protectedCount: number,
): RunRetentionBatchResult {
  const deleted = ids.length === 0 ? 0 : tx.delete(runs).where(inArray(runs.id, ids)).run().changes;
  return {
    examined,
    protected: protectedCount,
    deleted,
    remainingEligible: Math.max(0, examined - protectedCount - deleted),
  };
}
