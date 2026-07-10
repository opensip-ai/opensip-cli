import { ValidationError } from '@opensip-cli/core';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import { runs, runSteps } from './schema/runs.js';

import type { StoredRun, StoredRunStep } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';
import type { DrizzleDataStore } from '@opensip-cli/datastore/internal';

/** Filters for querying the host-owned run ledger. */
export interface RunListOptions {
  readonly limit?: number;
  readonly source?: StoredRun['source'];
}

/** Repository for persisted host-owned runs and ordered run steps. */
export class RunRepo {
  private readonly datastore: DrizzleDataStore;

  constructor(datastore: DataStore) {
    this.datastore = requireDrizzleHandle(datastore);
  }

  saveRunWithSteps(run: StoredRun, steps: readonly StoredRunStep[]): void {
    if (steps.some((step) => step.runId !== run.id)) {
      throw new ValidationError(`Run ${run.id} has a step with a mismatched runId.`, {
        code: 'VALIDATION.RUN_STEP.RUN_ID_MISMATCH',
      });
    }
    this.validateRun(run);
    for (const step of steps) this.validateStep(step);

    this.datastore.withWriteLock('run.save', () => {
      this.datastore.transaction((tx) => {
        tx.insert(runs)
          .values(runToRow(run))
          .onConflictDoUpdate({
            target: runs.id,
            set: runToRow(run),
          })
          .run();
        for (const step of steps) {
          tx.insert(runSteps)
            .values(stepToRow(step))
            .onConflictDoUpdate({
              target: runSteps.id,
              set: stepToRow(step),
            })
            .run();
        }
      });
    });
  }

  saveRun(run: StoredRun): void {
    this.saveRunWithSteps(run, []);
  }

  saveStep(step: StoredRunStep): void {
    this.validateStep(step);
    this.datastore.withWriteLock('run-step.save', () => {
      this.datastore.db
        .insert(runSteps)
        .values(stepToRow(step))
        .onConflictDoUpdate({ target: runSteps.id, set: stepToRow(step) })
        .run();
    });
  }

  getRun(id: string): StoredRun | null {
    const row = this.datastore.db.select().from(runs).where(eq(runs.id, id)).get();
    return row === undefined ? null : runFromRow(row);
  }

  listRuns(opts: RunListOptions = {}): readonly StoredRun[] {
    const base =
      opts.source === undefined
        ? this.datastore.db.select().from(runs)
        : this.datastore.db.select().from(runs).where(eq(runs.source, opts.source));
    const ordered = base.orderBy(desc(runs.completed_at));
    const rows = opts.limit === undefined ? ordered.all() : ordered.limit(opts.limit).all();
    return rows.map(runFromRow);
  }

  listStepsForRun(runId: string): readonly StoredRunStep[] {
    return this.datastore.db
      .select()
      .from(runSteps)
      .where(eq(runSteps.run_id, runId))
      .orderBy(runSteps.ordinal, runSteps.attempt)
      .all()
      .map(stepFromRow);
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

  private validateRun(run: StoredRun): void {
    const startedMs = new Date(run.startedAt).getTime();
    const completedMs = new Date(run.completedAt).getTime();
    if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) {
      throw new ValidationError(
        `Invalid run timing for run ${run.id}: startedAt=${JSON.stringify(run.startedAt)} completedAt=${JSON.stringify(run.completedAt)}`,
        { code: 'VALIDATION.RUN.INVALID_TIMESTAMP' },
      );
    }
  }

  private validateStep(step: StoredRunStep): void {
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
