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
export interface EvalReportCliTarget {
  readonly source: 'installed' | 'workspace';
  /** Entrypoint basename only (e.g. `index.js`); never an absolute or home path. */
  readonly entrypointName: string;
}

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
  return (
    isRecord(value) &&
    (value.source === 'installed' || value.source === 'workspace') &&
    isPopulatedString(value.entrypointName)
  );
}

function hasRequiredStepRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    isPopulatedString(value.stepId) &&
    isPopulatedString(value.tool) &&
    typeof value.responseBytes === 'number' &&
    Number.isFinite(value.responseBytes) &&
    typeof value.wallMs === 'number' &&
    Number.isFinite(value.wallMs) &&
    Array.isArray(value.facts) &&
    (value.proofRelevance === undefined ||
      value.proofRelevance === 'irrelevant' ||
      value.proofRelevance === 'projection') &&
    !('renderedResponse' in value)
  );
}

function hasRequiredArmRecord(value: unknown, arm: Arm): boolean {
  if (
    !isRecord(value) ||
    value.arm !== arm ||
    !isPopulatedString(value.taskId) ||
    !isPopulatedString(value.strategyVersion) ||
    !isRecord(value.setup) ||
    !Array.isArray(value.legs)
  ) {
    return false;
  }
  return value.legs.every(
    (leg) =>
      isRecord(leg) &&
      isPopulatedString(leg.leg) &&
      Array.isArray(leg.steps) &&
      leg.steps.every(hasRequiredStepRecord),
  );
}

function hasRequiredMetrics(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.callCount === 'number' &&
    typeof value.responseBytes === 'number' &&
    typeof value.totalWallMs === 'number'
  );
}

function hasRequiredAssertions(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.passed === 'boolean' &&
    typeof value.incorrectNone === 'number' &&
    Array.isArray(value.scopes)
  );
}

function hasRequiredArmResult(value: unknown, arm: Arm, taskId: string): boolean {
  return (
    isRecord(value) &&
    hasRequiredAssertions(value.assertions) &&
    hasRequiredMetrics(value.metrics) &&
    hasRequiredMetrics(value.recoveryMetrics) &&
    hasRequiredArmRecord(value.record, arm) &&
    isRecord(value.record) &&
    value.record.taskId === taskId
  );
}

function hasRequiredTaskResult(value: unknown, selectedArms: readonly Arm[]): boolean {
  if (!isRecord(value)) return false;
  const arms = value.arms;
  const taskId = value.taskId;
  if (!isPopulatedString(taskId) || !isPopulatedString(value.completedAt) || !isRecord(arms)) {
    return false;
  }
  const keys = Object.keys(arms);
  if (keys.some((key) => !isArm(key)) || keys.length !== selectedArms.length) return false;
  return selectedArms.every((arm) => hasRequiredArmResult(arms[arm], arm, taskId));
}

/**
 * Validate the required schema-v1 surface while tolerating additive unknown
 * fields. This is the sole report-shape validator used by CLI and smoke mode.
 */
export function validateEvalReport(value: unknown): value is EvalReport {
  if (
    !isRecord(value) ||
    value.schemaVersion !== EVAL_REPORT_SCHEMA_VERSION ||
    !Number.isInteger(value.schemaVersion) ||
    !isPopulatedString(value.harnessVersion) ||
    !isPopulatedString(value.cliVersion) ||
    typeof value.contractFingerprint !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.contractFingerprint) ||
    !isPopulatedString(value.gitSha) ||
    !isPopulatedString(value.platform) ||
    !isPopulatedString(value.nodeVersion) ||
    typeof value.promotionEligible !== 'boolean' ||
    !isSourceState(value.sourceState) ||
    value.promotionEligible !== (value.sourceState === 'clean') ||
    !isPopulatedString(value.startedAt) ||
    !isPopulatedString(value.completedAt) ||
    !isValidCliTarget(value.cliTarget) ||
    !Array.isArray(value.selectedArms) ||
    !Array.isArray(value.tasks) ||
    value.tasks.length === 0
  ) {
    return false;
  }
  if (
    value.selectedArms.length === 0 ||
    value.selectedArms.some((arm) => !isArm(arm)) ||
    new Set(value.selectedArms).size !== value.selectedArms.length
  ) {
    return false;
  }
  const selectedArms = value.selectedArms as readonly Arm[];
  const taskIds = new Set<string>();
  for (const task of value.tasks) {
    if (!hasRequiredTaskResult(task, selectedArms)) return false;
    const taskId = (task as Readonly<Record<string, unknown>>).taskId;
    if (typeof taskId !== 'string' || taskIds.has(taskId)) return false;
    taskIds.add(taskId);
  }
  return true;
}
