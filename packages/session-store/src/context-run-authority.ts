import { EXIT_CODES } from '@opensip-cli/contracts';
import { isRecord } from '@opensip-cli/core';

import {
  GRAPH_TOOL_ID,
  GRAPH_TOOL_NAME,
  PLANE_AUTHORITY,
  SAFE_VERSION,
  boundedControlFreeText,
  exactKeys,
  safeDuration,
  safeRunId,
  safeStepId,
} from './context-authority-shared.js';
import { projectedEvidenceStatus } from './context-plane-authority.js';

import type {
  StoredRun,
  StoredRunStep,
  TaskContextManifest,
  TaskContextPlaneKind,
} from '@opensip-cli/contracts';

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (!boundedControlFreeText(value, 64)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function runMetadataIsSafe(run: StoredRun): boolean {
  const aggregate: unknown = run.aggregate;
  if (
    !safeRunId(run.id) ||
    !canonicalTimestamp(run.startedAt) ||
    !canonicalTimestamp(run.completedAt) ||
    !safeDuration(run.durationMs) ||
    (run.exitCode !== EXIT_CODES.SUCCESS && run.exitCode !== EXIT_CODES.RUNTIME_ERROR) ||
    (run.cliVersion !== undefined &&
      (!boundedControlFreeText(run.cliVersion, 128) || !SAFE_VERSION.test(run.cliVersion))) ||
    !isRecord(aggregate) ||
    !exactKeys(aggregate, ['steps', 'passed', 'failed', 'faulted', 'errors', 'warnings'])
  ) {
    return false;
  }
  if (Date.parse(run.completedAt) < Date.parse(run.startedAt)) return false;
  const counts = [
    aggregate.steps,
    aggregate.passed,
    aggregate.failed,
    aggregate.faulted,
    aggregate.errors,
    aggregate.warnings,
  ];
  return (
    counts.every(safeCount) &&
    aggregate.steps === 3 &&
    (aggregate.passed as number) + (aggregate.failed as number) + (aggregate.faulted as number) ===
      aggregate.steps
  );
}

function stepMetadataIsSafe(step: StoredRunStep): boolean {
  return (
    (step.outcome === 'passed' || step.outcome === 'faulted') &&
    (step.exitCode === EXIT_CODES.SUCCESS || step.exitCode === EXIT_CODES.RUNTIME_ERROR) &&
    safeDuration(step.durationMs) &&
    step.verdictSummary === undefined
  );
}

export function aggregateMatchesStoredSteps(
  run: StoredRun,
  steps: readonly StoredRunStep[],
): boolean {
  let passed = 0;
  let faulted = 0;
  for (const step of steps) {
    if (!stepMetadataIsSafe(step)) return false;
    if (step.outcome === 'passed') passed += 1;
    else faulted += 1;
  }
  return (
    run.aggregate.steps === steps.length &&
    run.aggregate.passed === passed &&
    run.aggregate.failed === 0 &&
    run.aggregate.faulted === faulted &&
    run.aggregate.errors === 0 &&
    run.aggregate.warnings === 0
  );
}

function stepMatchesV1Authority(step: StoredRunStep): boolean {
  const entry = Object.entries(PLANE_AUTHORITY).find(
    ([, candidate]) => candidate.ordinal === step.ordinal,
  );
  if (entry === undefined) return false;
  const [kind, authority] = entry as [
    TaskContextPlaneKind,
    (typeof PLANE_AUTHORITY)[TaskContextPlaneKind],
  ];
  const evidenceStatus = projectedEvidenceStatus(step, kind, authority.command);
  if (evidenceStatus === undefined) return false;
  const expectedOutcome =
    evidenceStatus === 'missing' || evidenceStatus === 'failed' || evidenceStatus === 'cancelled'
      ? 'faulted'
      : 'passed';
  return (
    step.tool === GRAPH_TOOL_NAME &&
    step.stableId === GRAPH_TOOL_ID &&
    step.command === authority.command &&
    step.attempt === 1 &&
    step.logicalStepKey === `${String(authority.ordinal)}:${GRAPH_TOOL_ID}:${authority.command}` &&
    step.outcome === expectedOutcome &&
    step.exitCode ===
      (expectedOutcome === 'faulted' ? EXIT_CODES.RUNTIME_ERROR : EXIT_CODES.SUCCESS)
  );
}

export function storedStepsMatchV1Authority(
  steps: readonly StoredRunStep[],
  runId: string,
): boolean {
  return (
    steps.length === Object.keys(PLANE_AUTHORITY).length &&
    new Set(steps.map((step) => step.id)).size === steps.length &&
    new Set(steps.map((step) => step.ordinal)).size === steps.length &&
    steps.every((step) => safeStepId(step.id) && step.runId === runId && safeRunId(step.runId)) &&
    steps.every(stepMatchesV1Authority)
  );
}

export function runExitMatchesAuthority(
  run: StoredRun,
  manifest: TaskContextManifest,
  steps: readonly StoredRunStep[],
): boolean {
  const expected =
    manifest.readiness === 'unavailable' || steps.some((step) => step.outcome === 'faulted')
      ? EXIT_CODES.RUNTIME_ERROR
      : EXIT_CODES.SUCCESS;
  return run.exitCode === expected;
}
