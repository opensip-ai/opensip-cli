import { isPlainRecord, tryCatch, ValidationError } from '@opensip-cli/core';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';

import { runs, runSteps } from './schema/runs.js';
import {
  isFiniteNonNegativeNumber,
  isJsonSerializable,
  isNonEmptyString,
  isNonNegativeInteger,
  isOptionalNonEmptyString,
  isOptionalString,
  isPlainJsonRecord,
  isStringRecord,
} from './write-shape-validation.js';

import type { StoredRun, StoredRunStep } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';
import type { DrizzleDataStore, DrizzleHandle } from '@opensip-cli/datastore/internal';

const MAX_OPAQUE_RUN_CONTEXT_BYTES = 64 * 1024;

function opaqueRunContextIsBounded(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const bounded = tryCatch(
    () => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_OPAQUE_RUN_CONTEXT_BYTES,
  );
  return bounded.ok && bounded.value;
}

/** Filters for querying the host-owned run ledger. */
export interface RunListOptions {
  readonly limit?: number;
  readonly source?: StoredRun['source'];
  readonly name?: string;
  readonly cwd?: string;
}

/** Package-private validated Run projection shared by both write paths. */
export interface PreparedRunWrite {
  readonly runId: string;
  readonly row: typeof runs.$inferInsert;
}

/** Package-private validated RunStep projection shared by both write paths. */
export interface PreparedRunStepWrite {
  readonly stepId: string;
  readonly runId: string;
  readonly sessionId?: string;
  readonly row: typeof runSteps.$inferInsert;
}

export function prepareRunWrite(run: StoredRun): PreparedRunWrite {
  validateRun(run);
  return { runId: run.id, row: runToRow(run) };
}

export function prepareRunStepWrite(step: StoredRunStep): PreparedRunStepWrite {
  validateStep(step);
  return {
    stepId: step.id,
    runId: step.runId,
    ...(step.sessionId === undefined ? {} : { sessionId: step.sessionId }),
    row: stepToRow(step),
  };
}

export function writePreparedRun(tx: DrizzleHandle, prepared: PreparedRunWrite): void {
  tx.insert(runs)
    .values(prepared.row)
    .onConflictDoUpdate({
      target: runs.id,
      set: prepared.row,
    })
    .run();
}

export function writePreparedRunStep(tx: DrizzleHandle, prepared: PreparedRunStepWrite): void {
  tx.insert(runSteps)
    .values(prepared.row)
    .onConflictDoUpdate({
      target: runSteps.id,
      set: prepared.row,
    })
    .run();
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
        code: 'VALIDATION.RUN_STEP.RUN_ID_MISMATCH',
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
    const row = this.datastore.db.select().from(runs).where(eq(runs.id, id)).get();
    return row === undefined ? null : runFromRow(row);
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
    const ordered = this.datastore.db
      .select()
      .from(runSteps)
      .where(eq(runSteps.run_id, runId))
      .orderBy(asc(runSteps.ordinal), asc(runSteps.attempt), asc(runSteps.id));
    const rows = limit === undefined ? ordered.all() : ordered.limit(limit).all();
    return rows.map(stepFromRow);
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
        .orderBy(runSteps.run_id, runSteps.ordinal, runSteps.attempt)
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

function validateRun(run: StoredRun): void {
  if (!runRowShapeIsValid(run)) {
    throw new ValidationError('Invalid required Run row shape.', {
      code: 'VALIDATION.RUN.INVALID_SHAPE',
    });
  }
  const startedMs = new Date(run.startedAt).getTime();
  const completedMs = new Date(run.completedAt).getTime();
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) {
    throw new ValidationError(
      `Invalid run timing for run ${run.id}: startedAt=${JSON.stringify(run.startedAt)} completedAt=${JSON.stringify(run.completedAt)}`,
      { code: 'VALIDATION.RUN.INVALID_TIMESTAMP' },
    );
  }
  if (run.contextManifest !== undefined && !opaqueRunContextIsBounded(run.contextManifest)) {
    throw new ValidationError(`Invalid bounded run context for run ${run.id}.`, {
      code: 'VALIDATION.RUN.INVALID_CONTEXT_MANIFEST',
    });
  }
}

function validateStep(step: StoredRunStep): void {
  if (!runStepRowShapeIsValid(step)) {
    throw new ValidationError('Invalid required RunStep row shape.', {
      code: 'VALIDATION.RUN_STEP.INVALID_SHAPE',
    });
  }
  if (!Number.isInteger(step.ordinal) || step.ordinal < 0) {
    throw new ValidationError(`Invalid ordinal for run step ${step.id}: ${step.ordinal}`, {
      code: 'VALIDATION.RUN_STEP.INVALID_ORDINAL',
    });
  }
  if (!Number.isInteger(step.attempt) || step.attempt < 1) {
    throw new ValidationError(`Invalid attempt for run step ${step.id}: ${step.attempt}`, {
      code: 'VALIDATION.RUN_STEP.INVALID_ATTEMPT',
    });
  }
}

function runRowShapeIsValid(value: unknown): value is StoredRun {
  if (!isPlainRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    runSourceIsValid(value.source) &&
    isOptionalString(value.correlationRunId) &&
    isNonEmptyString(value.cwd) &&
    typeof value.startedAt === 'string' &&
    typeof value.completedAt === 'string' &&
    isFiniteNonNegativeNumber(value.durationMs) &&
    typeof value.exitCode === 'number' &&
    Number.isInteger(value.exitCode) &&
    runAggregateShapeIsValid(value.aggregate) &&
    (value.scope === undefined || runScopeShapeIsValid(value.scope)) &&
    (value.reviewBrief === undefined || isPlainJsonRecord(value.reviewBrief)) &&
    isOptionalNonEmptyString(value.legacySuiteRunId) &&
    isOptionalString(value.cliVersion) &&
    (value.engineVersions === undefined || isStringRecord(value.engineVersions))
  );
}

function runSourceIsValid(value: unknown): value is StoredRun['source'] {
  return (
    value === 'implicit-tool' ||
    value === 'configured-suite' ||
    value === 'built-in-suite' ||
    value === 'reconstructed' ||
    value === 'scheduled' ||
    value === 'cloud-triggered' ||
    value === 'mcp-triggered'
  );
}

function runAggregateShapeIsValid(value: unknown): value is StoredRun['aggregate'] {
  if (!isPlainRecord(value)) return false;
  return ['steps', 'passed', 'failed', 'faulted', 'errors', 'warnings'].every((key) =>
    isNonNegativeInteger(value[key]),
  );
}

function runScopeShapeIsValid(value: unknown): boolean {
  if (!isPlainJsonRecord(value)) return false;
  return (
    (value.mode === 'changed' || value.mode === 'full') &&
    (value.source === 'default' || value.source === 'explicit' || value.source === 'fallback') &&
    isOptionalString(value.ref) &&
    (value.changedFiles === undefined || isNonNegativeInteger(value.changedFiles)) &&
    isOptionalString(value.notice)
  );
}

function runStepRowShapeIsValid(value: unknown): value is StoredRunStep {
  if (!isPlainRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.logicalStepKey) &&
    typeof value.ordinal === 'number' &&
    Number.isInteger(value.ordinal) &&
    typeof value.attempt === 'number' &&
    Number.isInteger(value.attempt) &&
    isNonEmptyString(value.tool) &&
    isNonEmptyString(value.command) &&
    isNonEmptyString(value.stableId) &&
    (value.effectiveArgs === undefined || isPlainJsonRecord(value.effectiveArgs)) &&
    typeof value.exitCode === 'number' &&
    Number.isInteger(value.exitCode) &&
    (value.outcome === 'passed' || value.outcome === 'failed' || value.outcome === 'faulted') &&
    isFiniteNonNegativeNumber(value.durationMs) &&
    (value.verdictSummary === undefined || verdictSummaryShapeIsValid(value.verdictSummary)) &&
    isOptionalNonEmptyString(value.sessionId) &&
    (value.evidence === undefined || isJsonSerializable(value.evidence)) &&
    isOptionalNonEmptyString(value.parentStepId) &&
    (value.dependency === undefined || isJsonSerializable(value.dependency))
  );
}

function verdictSummaryShapeIsValid(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.passed === 'boolean' &&
    isNonNegativeInteger(value.errors) &&
    isNonNegativeInteger(value.warnings) &&
    isNonNegativeInteger(value.findings)
  );
}

function runToRow(run: StoredRun): typeof runs.$inferInsert {
  const startedMs = new Date(run.startedAt).getTime();
  const completedMs = new Date(run.completedAt).getTime();
  return {
    id: run.id,
    name: run.name,
    source: run.source,
    correlation_run_id: run.correlationRunId ?? null,
    cwd: run.cwd,
    started_at: startedMs,
    started_at_iso: run.startedAt,
    completed_at: completedMs,
    completed_at_iso: run.completedAt,
    duration_ms: run.durationMs,
    exit_code: run.exitCode,
    aggregate: run.aggregate,
    scope: run.scope ?? null,
    review_brief: run.reviewBrief ?? null,
    context_manifest: run.contextManifest ?? null,
    legacy_suite_run_id: run.legacySuiteRunId ?? null,
    cli_version: run.cliVersion ?? null,
    engine_versions: run.engineVersions ?? null,
  };
}

function runFromRow(row: typeof runs.$inferSelect): StoredRun {
  return {
    id: row.id,
    name: row.name,
    source: row.source as StoredRun['source'],
    ...(row.correlation_run_id === null ? {} : { correlationRunId: row.correlation_run_id }),
    cwd: row.cwd,
    startedAt: row.started_at_iso ?? new Date(row.started_at).toISOString(),
    completedAt: row.completed_at_iso ?? new Date(row.completed_at).toISOString(),
    durationMs: row.duration_ms,
    exitCode: row.exit_code,
    aggregate: row.aggregate as StoredRun['aggregate'],
    ...(row.scope == null ? {} : { scope: row.scope as StoredRun['scope'] }),
    ...(row.review_brief == null
      ? {}
      : { reviewBrief: row.review_brief as StoredRun['reviewBrief'] }),
    ...(row.context_manifest == null
      ? {}
      : { contextManifest: row.context_manifest as StoredRun['contextManifest'] }),
    ...(row.legacy_suite_run_id === null ? {} : { legacySuiteRunId: row.legacy_suite_run_id }),
    ...(row.cli_version === null ? {} : { cliVersion: row.cli_version }),
    ...(row.engine_versions == null
      ? {}
      : { engineVersions: row.engine_versions as StoredRun['engineVersions'] }),
  };
}

function stepToRow(step: StoredRunStep): typeof runSteps.$inferInsert {
  return {
    id: step.id,
    run_id: step.runId,
    logical_step_key: step.logicalStepKey,
    ordinal: step.ordinal,
    attempt: step.attempt,
    tool: step.tool,
    command: step.command,
    stable_id: step.stableId,
    effective_args: step.effectiveArgs ?? null,
    exit_code: step.exitCode,
    outcome: step.outcome,
    duration_ms: step.durationMs,
    verdict_summary: step.verdictSummary ?? null,
    session_id: step.sessionId ?? null,
    evidence: step.evidence ?? null,
    parent_step_id: step.parentStepId ?? null,
    dependency: step.dependency ?? null,
  };
}

function stepFromRow(row: typeof runSteps.$inferSelect): StoredRunStep {
  return {
    id: row.id,
    runId: row.run_id,
    logicalStepKey: row.logical_step_key,
    ordinal: row.ordinal,
    attempt: row.attempt,
    tool: row.tool,
    command: row.command,
    stableId: row.stable_id,
    ...(row.effective_args == null
      ? {}
      : {
          effectiveArgs: row.effective_args as StoredRunStep['effectiveArgs'],
        }),
    exitCode: row.exit_code,
    outcome: row.outcome as StoredRunStep['outcome'],
    durationMs: row.duration_ms,
    ...(row.verdict_summary == null
      ? {}
      : {
          verdictSummary: row.verdict_summary as StoredRunStep['verdictSummary'],
        }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.evidence == null ? {} : { evidence: row.evidence }),
    ...(row.parent_step_id === null ? {} : { parentStepId: row.parent_step_id }),
    ...(row.dependency == null ? {} : { dependency: row.dependency }),
  };
}
