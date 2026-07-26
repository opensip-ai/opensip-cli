import { resolve, sep } from 'node:path';

import { ValidationError } from '@opensip-cli/core';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { and, asc, count, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';

import { sessionStoreErrorCatalog } from './errors/session-store-error-catalog.js';
import {
  countRunRows,
  EMPTY_RUN_RETENTION_RESULT,
  MAX_RUN_RETENTION_BATCH_SIZE,
  pruneAgedRunBatch,
  pruneCountExcessRunBatch,
  requireRetentionBatchSize,
} from './run-retention.js';
import {
  prepareRunStepWrite,
  prepareRunWrite,
  runFromRow,
  stepFromRow,
  writePreparedRun,
  writePreparedRunStep,
} from './run-write-shapes.js';
import { runs, runSteps } from './schema/runs.js';

import type { RunRetentionBatchResult } from './run-retention.js';
import type { StoredRun, StoredRunStep } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';
import type { DrizzleDataStore, DrizzleHandle } from '@opensip-cli/datastore/internal';


// Plan 01: 22 literals become five registered definitions; the branch lives in metadata.
const WRITE_INVALID = sessionStoreErrorCatalog.require('SESSION.WRITE.RECORD_INVALID');

export { MAX_RUN_RETENTION_BATCH_SIZE, type RunRetentionBatchResult } from './run-retention.js';
export {
  isResolvableStoredRunId,
  prepareRunStepWrite,
  prepareRunWrite,
  writePreparedRun,
  writePreparedRunStep,
  type PreparedRunStepWrite,
  type PreparedRunWrite,
} from './run-write-shapes.js';

/** Filters for querying the host-owned run ledger. */
export interface RunListOptions {
  readonly limit?: number;
  readonly source?: StoredRun['source'];
  readonly name?: string;
  readonly cwd?: string;
}

/** Package-private exact Run read for transaction-scoped projections. */
export function readRunByIdFromTx(tx: DrizzleHandle, runId: string): StoredRun | null {
  const row = tx.select().from(runs).where(eq(runs.id, runId)).get();
  return row === undefined ? null : runFromRow(row);
}

/** Package-private deterministic newest-first Run page. */
export function readRunsPageFromTx(
  tx: DrizzleHandle,
  offset: number,
  limit: number,
  cwdWithin?: string,
): readonly StoredRun[] {
  const query = tx.select().from(runs);
  const scoped = cwdWithin === undefined ? query : query.where(runCwdWithinPredicate(cwdWithin));
  return scoped
    .orderBy(desc(runs.completed_at), desc(runs.id))
    .offset(offset)
    .limit(limit)
    .all()
    .map(runFromRow);
}

/** Package-private corruption probe used before exposing resolvable Run IDs. */
export function readUnresolvableRunIdFromTx(tx: DrizzleHandle, cwdWithin?: string): string | null {
  const invalidId = sql<boolean>`NOT (length(${runs.id}) BETWEEN 1 AND 128 AND ${runs.id} NOT GLOB '*[^A-Za-z0-9_-]*')`;
  const predicate =
    cwdWithin === undefined ? invalidId : and(invalidId, runCwdWithinPredicate(cwdWithin));
  const row = tx
    .select({ id: runs.id })
    .from(runs)
    .where(predicate)
    .orderBy(desc(runs.completed_at), desc(runs.id))
    .limit(1)
    .get();
  return row?.id ?? null;
}

function runCwdWithinPredicate(root: string) {
  const normalizedRoot = resolve(root);
  const descendantPrefix = normalizedRoot.endsWith(sep)
    ? normalizedRoot
    : `${normalizedRoot}${sep}`;
  const prefixCodePoints = [...descendantPrefix].length;
  return or(
    eq(runs.cwd, normalizedRoot),
    sql<boolean>`substr(${runs.cwd}, 1, ${prefixCodePoints}) = ${descendantPrefix}`,
  );
}

/** Package-private exact RunStep count for one parent. */
export function countRunStepsFromTx(tx: DrizzleHandle, runId: string): number {
  return (
    tx.select({ value: count() }).from(runSteps).where(eq(runSteps.run_id, runId)).get()?.value ?? 0
  );
}

/** Package-private deterministic RunStep page for transaction-scoped projections. */
export function readRunStepsPageFromTx(
  tx: DrizzleHandle,
  runId: string,
  offset: number,
  limit: number,
): readonly StoredRunStep[] {
  return tx
    .select()
    .from(runSteps)
    .where(eq(runSteps.run_id, runId))
    .orderBy(asc(runSteps.ordinal), asc(runSteps.attempt), asc(runSteps.id))
    .offset(offset)
    .limit(limit)
    .all()
    .map(stepFromRow);
}

/** Repository for persisted host-owned runs and ordered run steps. */
export class RunRepo {
  private readonly datastore: DrizzleDataStore;

  constructor(datastore: DataStore) {
    this.datastore = requireDrizzleHandle(datastore);
  }

  saveRunWithSteps(run: StoredRun, steps: readonly StoredRunStep[]): void {
    this.persistRunWithSteps(run, steps, () => true);
  }

  /**
   * Atomically persist only when a synchronous read-only guard still holds
   * after the datastore write lock and transaction have both been entered.
   */
  saveRunWithStepsIf(
    run: StoredRun,
    steps: readonly StoredRunStep[],
    precondition: () => boolean,
  ): boolean {
    return this.persistRunWithSteps(run, steps, precondition);
  }

  private persistRunWithSteps(
    run: StoredRun,
    steps: readonly StoredRunStep[],
    precondition: () => boolean,
  ): boolean {
    if (steps.some((step) => step.runId !== run.id)) {
      throw new ValidationError(`Run ${run.id} has a step with a mismatched runId.`, {
        code: WRITE_INVALID.code,
        definition: WRITE_INVALID,
        metadata: { field: 'step-run-id-mismatch' },
      });
    }
    const preparedRun = prepareRunWrite(run);
    const preparedSteps = steps.map(prepareRunStepWrite);

    let saved = false;
    this.datastore.withWriteLock('run.save', () => {
      this.datastore.transaction((tx) => {
        if (!precondition()) return;
        writePreparedRun(tx, preparedRun);
        for (const preparedStep of preparedSteps) {
          writePreparedRunStep(tx, preparedStep);
        }
        saved = true;
      });
    });
    return saved;
  }

  saveRun(run: StoredRun): void {
    this.saveRunWithSteps(run, []);
  }

  saveStep(step: StoredRunStep): void {
    const prepared = prepareRunStepWrite(step);
    this.datastore.withWriteLock('run-step.save', () => {
      writePreparedRunStep(this.datastore.db, prepared);
    });
  }

  getRun(id: string): StoredRun | null {
    return readRunByIdFromTx(this.datastore.db, id);
  }

  listRuns(opts: RunListOptions = {}): readonly StoredRun[] {
    const conditions = [
      ...(opts.source === undefined ? [] : [eq(runs.source, opts.source)]),
      ...(opts.name === undefined ? [] : [eq(runs.name, opts.name)]),
      ...(opts.cwd === undefined ? [] : [eq(runs.cwd, opts.cwd)]),
    ];
    const query = this.datastore.db.select().from(runs);
    const base = conditions.length === 0 ? query : query.where(and(...conditions));
    const ordered = base.orderBy(desc(runs.completed_at), desc(runs.id));
    const rows = opts.limit === undefined ? ordered.all() : ordered.limit(opts.limit).all();
    return rows.map(runFromRow);
  }

  listStepsForRun(runId: string, limit?: number): readonly StoredRunStep[] {
    if (limit !== undefined) {
      return readRunStepsPageFromTx(this.datastore.db, runId, 0, limit);
    }
    return this.datastore.db
      .select()
      .from(runSteps)
      .where(eq(runSteps.run_id, runId))
      .orderBy(asc(runSteps.ordinal), asc(runSteps.attempt), asc(runSteps.id))
      .all()
      .map(stepFromRow);
  }

  countStepsForRun(runId: string): number {
    return countRunStepsFromTx(this.datastore.db, runId);
  }

  listStepsForRunPage(runId: string, offset: number, limit: number): readonly StoredRunStep[] {
    return readRunStepsPageFromTx(this.datastore.db, runId, offset, limit);
  }

  listStepsForRuns(runIds: readonly string[]): ReadonlyMap<string, readonly StoredRunStep[]> {
    const byRun = new Map<string, StoredRunStep[]>();
    if (runIds.length === 0) return byRun;
    const CHUNK = 2000;
    for (let i = 0; i < runIds.length; i += CHUNK) {
      const chunk = runIds.slice(i, i + CHUNK);
      const rows = this.datastore.db
        .select()
        .from(runSteps)
        .where(inArray(runSteps.run_id, chunk))
        .orderBy(
          asc(runSteps.run_id),
          asc(runSteps.ordinal),
          asc(runSteps.attempt),
          asc(runSteps.id),
        )
        .all();
      for (const row of rows) {
        const step = stepFromRow(row);
        const bucket = byRun.get(step.runId);
        if (bucket === undefined) byRun.set(step.runId, [step]);
        else bucket.push(step);
      }
    }
    return byRun;
  }

  countRuns(): number {
    return countRunRows(this.datastore.db);
  }

  /**
   * Delete at most one deterministic oldest-first batch outside the newest
   * `keep` parent Runs. A linked retained Session protects its complete parent.
   */
  pruneToCountBatch(
    keep: number,
    batchSize = MAX_RUN_RETENTION_BATCH_SIZE,
  ): RunRetentionBatchResult {
    const normalizedBatchSize = requireRetentionBatchSize(batchSize);
    if (!Number.isFinite(keep)) return EMPTY_RUN_RETENTION_RESULT;
    const normalizedKeep = Math.trunc(keep);
    if (normalizedKeep <= 0) return EMPTY_RUN_RETENTION_RESULT;
    return this.datastore.withWriteLock('run.retention.count', () =>
      this.datastore.transaction((tx) =>
        pruneCountExcessRunBatch(tx, normalizedKeep, normalizedBatchSize),
      ),
    );
  }

  /**
   * Delete at most one deterministic oldest-first batch completed before the
   * cutoff. Parents with a still-linked Session remain protected.
   */
  pruneOlderThanBatch(
    before: Date,
    batchSize = MAX_RUN_RETENTION_BATCH_SIZE,
  ): RunRetentionBatchResult {
    const cutoff = before.getTime();
    if (!Number.isFinite(cutoff)) return EMPTY_RUN_RETENTION_RESULT;
    const normalizedBatchSize = requireRetentionBatchSize(batchSize);
    return this.datastore.withWriteLock('run.retention.age', () =>
      this.datastore.transaction((tx) => pruneAgedRunBatch(tx, cutoff, normalizedBatchSize)),
    );
  }

  getRunByLegacySuiteRunId(suiteRunId: string): StoredRun | null {
    const row = this.datastore.db
      .select()
      .from(runs)
      .where(eq(runs.legacy_suite_run_id, suiteRunId))
      .orderBy(desc(runs.completed_at))
      .get();
    return row === undefined ? null : runFromRow(row);
  }

  getStepBySessionId(sessionId: string): StoredRunStep | null {
    const row = this.datastore.db
      .select()
      .from(runSteps)
      .where(eq(runSteps.session_id, sessionId))
      .get();
    return row === undefined ? null : stepFromRow(row);
  }

  /** Whether this delegation already persisted its exact implicit run evidence. */
  hasImplicitRunForCommand(
    correlationRunId: string,
    tool: string,
    command: string,
    delegatedAt: string,
  ): boolean {
    const delegatedAtMs = new Date(delegatedAt).getTime();
    if (!Number.isFinite(delegatedAtMs)) return false;
    const row = this.datastore.db
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(runSteps, eq(runSteps.run_id, runs.id))
      .where(
        and(
          eq(runs.source, 'implicit-tool'),
          eq(runs.correlation_run_id, correlationRunId),
          eq(runSteps.tool, tool),
          eq(runSteps.command, command),
          gte(runs.started_at, delegatedAtMs),
        ),
      )
      .limit(1)
      .get();
    return row !== undefined;
  }
}
