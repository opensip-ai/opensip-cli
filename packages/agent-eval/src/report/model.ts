import { isStepFailureCode } from '../model/record.js';
import { isUnknownRecord as isRecord } from '../model/value-helpers.js';

import type { ArmRunRecord } from '../model/record.js';
import type { Arm } from '../model/task.js';
import type { AssertionResult } from '../scorer/assertions.js';
import type { ArmMetrics, RecoveryMetrics } from '../scorer/metrics.js';

export const EVAL_REPORT_SCHEMA_VERSION = 1;

/** Git worktree state observed across the evaluation interval. */
export type SourceState = 'changed-during-run' | 'clean' | 'dirty';

/** Report-ready record and scoring for one evaluated arm. */
export interface EvalArmResult {
  readonly assertions: AssertionResult;
  readonly metrics: ArmMetrics;
  readonly record: ArmRunRecord;
  readonly recoveryMetrics: RecoveryMetrics;
}

/** Results for the subset of arms selected by one invocation. */
export type EvalArmResults = Partial<Readonly<Record<Arm, EvalArmResult>>>;

/** Report-ready paired or single-arm result for one gold task. */
export interface EvalTaskResult {
  readonly arms: EvalArmResults;
  readonly completedAt: string;
  readonly taskId: string;
}

/**
 * Non-sensitive identity of the CLI build the harness measured. Additive to
 * schema v1: absent in reports produced before this field existed, and present
 * for every report the current harness writes. Carries no absolute path.
 */
interface EvalReportCliTargetBase {
  /** Entrypoint basename only (e.g. `index.js`); never an absolute or home path. */
  readonly entrypointName: string;
}

export interface EvalReportInstalledCliTarget extends EvalReportCliTargetBase {
  /** Digest of the exact package-declared JS bytes measured by every child. */
  readonly entrypointSha256?: `sha256:${string}`;
  /** Digest of the package manifest that bound `bin.opensip` to the entrypoint. */
  readonly packageJsonSha256?: `sha256:${string}`;
  readonly source: 'installed';
}

export interface EvalReportWorkspaceCliTarget extends EvalReportCliTargetBase {
  readonly source: 'workspace';
}

export type EvalReportCliTarget = EvalReportInstalledCliTarget | EvalReportWorkspaceCliTarget;

/** Immutable file-plane result. Raw tool responses never cross into this shape. */
export interface EvalReport {
  readonly cliVersion: string;
  /** Additive (schema-v1 tolerant): which CLI build the harness measured. */
  readonly cliTarget?: EvalReportCliTarget;
  readonly completedAt: string;
  readonly contractFingerprint: string;
  readonly gitSha: string;
  readonly harnessVersion: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly promotionEligible: boolean;
  readonly schemaVersion: typeof EVAL_REPORT_SCHEMA_VERSION;
  readonly selectedArms: readonly Arm[];
  readonly sourceState: SourceState;
  readonly startedAt: string;
  readonly tasks: readonly EvalTaskResult[];
}

/** Bounded, data-free diagnostic returned when a report fails schema validation. */
export interface EvalReportValidationFailure {
  readonly field: string;
  readonly ok: false;
}

/** Successful validation carries no report data across the diagnostic seam. */
export interface EvalReportValidationSuccess {
  readonly ok: true;
}

export type EvalReportValidationResult = EvalReportValidationFailure | EvalReportValidationSuccess;

function isPopulatedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isArm(value: unknown): value is Arm {
  return value === 'control' || value === 'opensip';
}

function isSourceState(value: unknown): value is SourceState {
  return value === 'changed-during-run' || value === 'clean' || value === 'dirty';
}

/**
 * Validate the optional additive `cliTarget` block. `undefined` is tolerated (old
 * fixtures); a present block must carry a known source and a populated identity.
 */
function isValidCliTarget(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !isPopulatedString(value.entrypointName)) return false;
  if (value.source === 'workspace') return true;
  if (
    value.source === 'installed' &&
    value.entrypointSha256 === undefined &&
    value.packageJsonSha256 === undefined
  ) {
    return true;
  }
  return (
    value.source === 'installed' &&
    typeof value.entrypointSha256 === 'string' &&
    /^sha256:[0-9a-f]{64}$/u.test(value.entrypointSha256) &&
    typeof value.packageJsonSha256 === 'string' &&
    /^sha256:[0-9a-f]{64}$/u.test(value.packageJsonSha256)
  );
}

function hasValidStepFailure(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    isStepFailureCode(value.code) &&
    (value.kind === 'binding' ||
      value.kind === 'infrastructure' ||
      value.kind === 'protocol' ||
      value.kind === 'tool') &&
    isPopulatedString(value.message) &&
    (value.retryable === undefined || typeof value.retryable === 'boolean')
  );
}

function invalidStepRecordField(value: unknown): string | undefined {
  if (!isRecord(value)) return '';
  if (!isPopulatedString(value.stepId)) return 'stepId';
  if (!isPopulatedString(value.tool)) return 'tool';
  if (typeof value.responseBytes !== 'number' || !Number.isFinite(value.responseBytes)) {
    return 'responseBytes';
  }
  if (typeof value.wallMs !== 'number' || !Number.isFinite(value.wallMs)) return 'wallMs';
  if (!Array.isArray(value.facts)) return 'facts';
  if (!hasValidStepFailure(value.failure)) return 'failure';
  if (
    value.proofRelevance !== undefined &&
    value.proofRelevance !== 'irrelevant' &&
    value.proofRelevance !== 'projection'
  ) {
    return 'proofRelevance';
  }
  if ('renderedResponse' in value) return 'renderedResponse';
  return undefined;
}

function joinField(parent: string, child: string): string {
  return child.length === 0 ? parent : `${parent}.${child}`;
}

function invalidLegField(value: unknown): string | undefined {
  if (!isRecord(value)) return '';
  if (!isPopulatedString(value.leg)) return 'leg';
  if (!Array.isArray(value.steps)) return 'steps';
  for (const [stepIndex, step] of value.steps.entries()) {
    const stepField = `steps[${String(stepIndex)}]`;
    const invalidStep = invalidStepRecordField(step);
    if (invalidStep !== undefined) return joinField(stepField, invalidStep);
  }
  return undefined;
}

function invalidArmRecordField(value: unknown, arm: Arm): string | undefined {
  if (!isRecord(value)) {
    return '';
  }
  if (value.arm !== arm) return 'arm';
  if (!isPopulatedString(value.taskId)) return 'taskId';
  if (!isPopulatedString(value.strategyVersion)) return 'strategyVersion';
  if (!isRecord(value.setup)) return 'setup';
  if (!Array.isArray(value.legs)) return 'legs';
  for (const [legIndex, leg] of value.legs.entries()) {
    const legField = `legs[${String(legIndex)}]`;
    const invalidLeg = invalidLegField(leg);
    if (invalidLeg !== undefined) return joinField(legField, invalidLeg);
  }
  return undefined;
}

function invalidMetricsField(value: unknown): string | undefined {
  if (!isRecord(value)) return '';
  if (typeof value.callCount !== 'number') return 'callCount';
  if (typeof value.responseBytes !== 'number') return 'responseBytes';
  if (typeof value.totalWallMs !== 'number') return 'totalWallMs';
  return undefined;
}

function invalidAssertionsField(value: unknown): string | undefined {
  if (!isRecord(value)) return '';
  if (typeof value.passed !== 'boolean') return 'passed';
  if (typeof value.incorrectNone !== 'number') return 'incorrectNone';
  if (!Array.isArray(value.scopes)) return 'scopes';
  return undefined;
}

function invalidArmResultField(value: unknown, arm: Arm, taskId: string): string | undefined {
  if (!isRecord(value)) return '';
  const assertions = invalidAssertionsField(value.assertions);
  if (assertions !== undefined) return joinField('assertions', assertions);
  const metrics = invalidMetricsField(value.metrics);
  if (metrics !== undefined) return joinField('metrics', metrics);
  const recoveryMetrics = invalidMetricsField(value.recoveryMetrics);
  if (recoveryMetrics !== undefined) return joinField('recoveryMetrics', recoveryMetrics);
  const record = invalidArmRecordField(value.record, arm);
  if (record !== undefined) return joinField('record', record);
  if (!isRecord(value.record) || value.record.taskId !== taskId) return 'record.taskId';
  return undefined;
}

function invalidTaskResultField(value: unknown, selectedArms: readonly Arm[]): string | undefined {
  if (!isRecord(value)) return '';
  const arms = value.arms;
  const taskId = value.taskId;
  if (!isPopulatedString(taskId) || !isPopulatedString(value.completedAt) || !isRecord(arms)) {
    if (!isPopulatedString(taskId)) return 'taskId';
    if (!isPopulatedString(value.completedAt)) return 'completedAt';
    return 'arms';
  }
  const keys = Object.keys(arms);
  if (keys.some((key) => !isArm(key)) || keys.length !== selectedArms.length) return 'arms';
  for (const arm of selectedArms) {
    const invalidArm = invalidArmResultField(arms[arm], arm, taskId);
    if (invalidArm !== undefined) return joinField(`arms.${arm}`, invalidArm);
  }
  return undefined;
}

function invalid(field: string): EvalReportValidationFailure {
  return { field, ok: false };
}

function invalidRootField(value: Readonly<Record<string, unknown>>): string | undefined {
  if (
    value.schemaVersion !== EVAL_REPORT_SCHEMA_VERSION ||
    !Number.isInteger(value.schemaVersion)
  ) {
    return 'schemaVersion';
  }
  if (!isPopulatedString(value.harnessVersion)) return 'harnessVersion';
  if (!isPopulatedString(value.cliVersion)) return 'cliVersion';
  if (
    typeof value.contractFingerprint !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.contractFingerprint)
  ) {
    return 'contractFingerprint';
  }
  if (!isPopulatedString(value.gitSha)) return 'gitSha';
  if (!isPopulatedString(value.platform)) return 'platform';
  if (!isPopulatedString(value.nodeVersion)) return 'nodeVersion';
  if (typeof value.promotionEligible !== 'boolean') return 'promotionEligible';
  if (!isSourceState(value.sourceState)) return 'sourceState';
  if (value.promotionEligible !== (value.sourceState === 'clean')) {
    return 'promotionEligible';
  }
  if (!isPopulatedString(value.startedAt)) return 'startedAt';
  if (!isPopulatedString(value.completedAt)) return 'completedAt';
  if (!isValidCliTarget(value.cliTarget)) return 'cliTarget';
  if (!Array.isArray(value.selectedArms)) return 'selectedArms';
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) return 'tasks';
  return undefined;
}

function invalidSelectedArms(selectedArms: readonly unknown[]): boolean {
  return (
    selectedArms.length === 0 ||
    selectedArms.some((arm) => !isArm(arm)) ||
    new Set(selectedArms).size !== selectedArms.length
  );
}

/**
 * Inspect the required schema-v1 surface without retaining report values in the
 * failure. The field path is safe to expose because it contains only schema
 * labels and bounded array indexes, never operator data.
 */
export function inspectEvalReport(value: unknown): EvalReportValidationResult {
  if (!isRecord(value)) return invalid('$');
  const rootField = invalidRootField(value);
  if (rootField !== undefined) return invalid(rootField);

  const selectedArms = value.selectedArms as readonly unknown[];
  if (invalidSelectedArms(selectedArms)) return invalid('selectedArms');
  const narrowedArms = selectedArms as readonly Arm[];
  const tasks = value.tasks as readonly unknown[];
  const taskIds = new Set<string>();
  for (const [index, task] of tasks.entries()) {
    const taskField = `tasks[${String(index)}]`;
    const invalidTask = invalidTaskResultField(task, narrowedArms);
    if (invalidTask !== undefined) return invalid(joinField(taskField, invalidTask));
    const taskId = (task as Readonly<Record<string, unknown>>).taskId;
    if (typeof taskId !== 'string' || taskIds.has(taskId)) return invalid(`${taskField}.taskId`);
    taskIds.add(taskId);
  }
  return { ok: true };
}

/**
 * Validate the required schema-v1 surface while tolerating additive unknown
 * fields. This is the sole report-shape validator used by CLI and smoke mode.
 */
export function validateEvalReport(value: unknown): value is EvalReport {
  return inspectEvalReport(value).ok;
}
