import { isPlainRecord, tryCatch, ValidationError } from '@opensip-cli/core';

import { sessionStoreErrorCatalog } from './errors/session-store-error-catalog.js';
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
import type { DrizzleHandle } from '@opensip-cli/datastore/internal';


// Plan 01: 22 literals become five registered definitions; the branch lives in metadata.
const WRITE_INVALID = sessionStoreErrorCatalog.require('SESSION.WRITE.RECORD_INVALID');

const MAX_OPAQUE_RUN_CONTEXT_BYTES = 64 * 1024;
const STORED_RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/** Package-private identity contract shared by Run writes and public reads. */
export function isResolvableStoredRunId(value: unknown): value is string {
  return typeof value === 'string' && STORED_RUN_ID_PATTERN.test(value);
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

/** Validate and project a stored parent Run into its persistence row. */
export function prepareRunWrite(run: StoredRun): PreparedRunWrite {
  validateRun(run);
  return { runId: run.id, row: runToRow(run) };
}

/** Validate and project a stored RunStep into its persistence row. */
export function prepareRunStepWrite(step: StoredRunStep): PreparedRunStepWrite {
  validateStep(step);
  return {
    stepId: step.id,
    runId: step.runId,
    ...(step.sessionId === undefined ? {} : { sessionId: step.sessionId }),
    row: stepToRow(step),
  };
}

/** Upsert one previously validated parent-Run row in the supplied transaction. */
export function writePreparedRun(tx: DrizzleHandle, prepared: PreparedRunWrite): void {
  tx.insert(runs)
    .values(prepared.row)
    .onConflictDoUpdate({
      target: runs.id,
      set: prepared.row,
    })
    .run();
}

/** Upsert one previously validated RunStep row in the supplied transaction. */
export function writePreparedRunStep(tx: DrizzleHandle, prepared: PreparedRunStepWrite): void {
  tx.insert(runSteps)
    .values(prepared.row)
    .onConflictDoUpdate({
      target: runSteps.id,
      set: prepared.row,
    })
    .run();
}

/** Hydrate one persisted parent-Run row into its contract projection. */
export function runFromRow(row: typeof runs.$inferSelect): StoredRun {
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
      : {
          contextManifest: row.context_manifest as StoredRun['contextManifest'],
        }),
    ...(row.legacy_suite_run_id === null ? {} : { legacySuiteRunId: row.legacy_suite_run_id }),
    ...(row.cli_version === null ? {} : { cliVersion: row.cli_version }),
    ...(row.engine_versions == null
      ? {}
      : { engineVersions: row.engine_versions as StoredRun['engineVersions'] }),
  };
}

/** Hydrate one persisted RunStep row into its contract projection. */
export function stepFromRow(row: typeof runSteps.$inferSelect): StoredRunStep {
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

function opaqueRunContextIsBounded(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const bounded = tryCatch(
    () => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_OPAQUE_RUN_CONTEXT_BYTES,
  );
  return bounded.ok && bounded.value;
}

function validateRun(run: StoredRun): void {
  if (!isResolvableStoredRunId(run.id)) {
    throw new ValidationError(
      'Run ID must contain 1-128 letters, numbers, underscores, or hyphens.',
      {
        code: WRITE_INVALID.code,
        definition: WRITE_INVALID,
        metadata: { field: 'run-id' },
      },
    );
  }
  if (!runRowShapeIsValid(run)) {
    throw new ValidationError('Invalid required Run row shape.', {
      code: WRITE_INVALID.code,
      definition: WRITE_INVALID,
      metadata: { field: 'run-shape' },
    });
  }
  const startedMs = new Date(run.startedAt).getTime();
  const completedMs = new Date(run.completedAt).getTime();
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) {
    throw new ValidationError(
      `Invalid run timing for run ${run.id}: startedAt=${JSON.stringify(run.startedAt)} completedAt=${JSON.stringify(run.completedAt)}`,
      { code: WRITE_INVALID.code, definition: WRITE_INVALID, metadata: { field: 'run-timestamp' } },
    );
  }
  if (run.contextManifest !== undefined && !opaqueRunContextIsBounded(run.contextManifest)) {
    throw new ValidationError(`Invalid bounded run context for run ${run.id}.`, {
      code: WRITE_INVALID.code,
      definition: WRITE_INVALID,
      metadata: { field: 'context-manifest' },
    });
  }
}

function validateStep(step: StoredRunStep): void {
  if (!runStepRowShapeIsValid(step)) {
    throw new ValidationError('Invalid required RunStep row shape.', {
      code: WRITE_INVALID.code,
      definition: WRITE_INVALID,
      metadata: { field: 'step-shape' },
    });
  }
  if (!Number.isInteger(step.ordinal) || step.ordinal < 0) {
    throw new ValidationError(`Invalid ordinal for run step ${step.id}: ${step.ordinal}`, {
      code: WRITE_INVALID.code,
      definition: WRITE_INVALID,
      metadata: { field: 'step-ordinal' },
    });
  }
  if (!Number.isInteger(step.attempt) || step.attempt < 1) {
    throw new ValidationError(`Invalid attempt for run step ${step.id}: ${step.attempt}`, {
      code: WRITE_INVALID.code,
      definition: WRITE_INVALID,
      metadata: { field: 'step-attempt' },
    });
  }
}

function runRowShapeIsValid(value: unknown): value is StoredRun {
  if (!isPlainRecord(value)) return false;
  return (
    isResolvableStoredRunId(value.id) &&
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
