import {
  EXIT_CODES,
  buildTaskContextProjectIdentity,
  taskContextManifestSchema,
  type StoredRun,
  type StoredRunStep,
  type SuiteRunResult,
  type TaskContextManifest,
} from '@opensip-cli/contracts';
import { generatePrefixedId, readPackageVersion } from '@opensip-cli/core';

import {
  projectEnvelopeEvidence,
  projectEvidenceSnapshotEvidence,
} from '../run-ledger-projection.js';

import {
  BUILT_IN_AGENT_CONTEXT_PLANES,
  BUILT_IN_AGENT_CONTEXT_SUITE_NAME,
  BUILT_IN_GRAPH_TOOL_ID,
  BUILT_IN_GRAPH_TOOL_NAME,
  type SuiteSource,
} from './built-in-suites.js';

import type { SuiteStepReviewInput } from './review-brief.js';
import type { EvidenceBundlePrecondition, EvidenceBundleRun } from '@opensip-cli/session-store';

const CLI_VERSION = readPackageVersion(import.meta.url);
const CONTEXT_RUN_ID = /^RUN_[0-9A-HJKMNP-TV-Z]{26}$/u;
const CONTEXT_STEP_ID = /^STEP_[0-9A-HJKMNP-TV-Z]{26}$/u;

function canonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function safeDuration(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

export interface ProjectSuiteRunInput {
  readonly result: SuiteRunResult;
  readonly internalSteps: readonly SuiteStepReviewInput[];
  readonly source: SuiteSource;
  readonly cwd: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly identity: SuiteLedgerIdentity;
  readonly correlationRunId?: string;
  /** Read-only guard evaluated under the datastore write lock before ledger insertion. */
  readonly persistencePrecondition?: () => boolean;
}

export interface SuiteRunLedgerProjection {
  readonly evidence: EvidenceBundleRun;
  readonly precondition?: EvidenceBundlePrecondition;
}

export interface SuiteLedgerStepIdentity {
  readonly id: string;
  readonly logicalStepKey: string;
  readonly ordinal: number;
  readonly attempt: number;
}

export interface SuiteLedgerIdentity {
  readonly runId: string;
  readonly steps: readonly SuiteLedgerStepIdentity[];
}

function persistedEffectiveArgs(
  value: Readonly<Record<string, unknown>> | undefined,
  redactContextPaths: boolean,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || !redactContextPaths) return value;
  const entries = Object.entries(value).filter(([key]) => key !== 'files');
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** Allocate the only parent/step IDs used by manifest construction and persistence. */
export function allocateSuiteLedgerIdentity(
  internalSteps: readonly SuiteStepReviewInput[],
): SuiteLedgerIdentity {
  return Object.freeze({
    runId: generatePrefixedId('run'),
    steps: Object.freeze(
      internalSteps.map((step) =>
        Object.freeze({
          id: generatePrefixedId('step'),
          logicalStepKey: `${step.stepIndex}:${step.summary.stableId}:${step.summary.command}`,
          ordinal: step.stepIndex,
          attempt: 1,
        }),
      ),
    ),
  });
}

function contextManifestMatchesHostAuthority(input: ProjectSuiteRunInput): boolean {
  const manifest = input.result.contextManifest;
  const isContextRun =
    input.source === 'built-in' && input.result.suite === BUILT_IN_AGENT_CONTEXT_SUITE_NAME;
  if (manifest === undefined) return !isContextRun;
  if (!isContextRun) return false;
  const parsed = taskContextManifestSchema.safeParse(manifest);
  if (!parsed.success) return false;
  return (
    contextStepsMatchHostAuthority(input) &&
    contextResultMatchesExecutedSteps(input) &&
    contextPlanesMatchLedgerIdentity(parsed.data, input.identity) &&
    parsed.data.runId === input.identity.runId &&
    parsed.data.projectIdentity === buildTaskContextProjectIdentity(input.cwd) &&
    manifestCreatedWithinRun(parsed.data, input.startedAt, input.completedAt)
  );
}

function manifestCreatedWithinRun(
  manifest: TaskContextManifest,
  startedAt: string,
  completedAt: string,
): boolean {
  const started = Date.parse(startedAt);
  const created = Date.parse(manifest.createdAt);
  const completed = Date.parse(completedAt);
  return (
    canonicalTimestamp(startedAt) &&
    canonicalTimestamp(completedAt) &&
    started <= created &&
    created <= completed
  );
}

function expectedEvidenceOutcome(step: SuiteStepReviewInput): 'passed' | 'faulted' | undefined {
  const contributions = step.evidenceSnapshots ?? [];
  if (contributions.length === 0) return 'faulted';
  if (contributions.length !== 1) return;
  const status = contributions[0]?.status;
  return status === 'failed' || status === 'cancelled' ? 'faulted' : 'passed';
}

function contextStepResultIsSafe(step: SuiteStepReviewInput): boolean {
  const expectedOutcome = expectedEvidenceOutcome(step);
  return (
    expectedOutcome !== undefined &&
    step.summary.outcome === expectedOutcome &&
    step.summary.exitCode ===
      (expectedOutcome === 'faulted' ? EXIT_CODES.RUNTIME_ERROR : EXIT_CODES.SUCCESS) &&
    safeDuration(step.summary.durationMs) &&
    step.summary.verdict === undefined
  );
}

function contextStepsMatchHostAuthority(input: ProjectSuiteRunInput): boolean {
  return (
    CONTEXT_RUN_ID.test(input.identity.runId) &&
    canonicalTimestamp(input.startedAt) &&
    canonicalTimestamp(input.completedAt) &&
    safeDuration(input.result.durationMs) &&
    input.internalSteps.length === BUILT_IN_AGENT_CONTEXT_PLANES.length &&
    input.identity.steps.length === BUILT_IN_AGENT_CONTEXT_PLANES.length &&
    new Set(input.identity.steps.map((identity) => identity.id)).size ===
      input.identity.steps.length &&
    input.identity.steps.every((identity) => CONTEXT_STEP_ID.test(identity.id)) &&
    BUILT_IN_AGENT_CONTEXT_PLANES.every((authority, ordinal) => {
      const step = input.internalSteps[ordinal];
      const identity = input.identity.steps[ordinal];
      const logicalStepKey = `${String(ordinal)}:${BUILT_IN_GRAPH_TOOL_ID}:${authority.command}`;
      return (
        step?.stepIndex === ordinal &&
        step.summary.tool === BUILT_IN_GRAPH_TOOL_NAME &&
        step.summary.stableId === BUILT_IN_GRAPH_TOOL_ID &&
        step.summary.command === authority.command &&
        step.summary.kind === 'evidence' &&
        contextStepResultIsSafe(step) &&
        identity?.ordinal === ordinal &&
        identity.attempt === 1 &&
        identity.logicalStepKey === logicalStepKey
      );
    })
  );
}

function aggregateExecutedContextSteps(
  steps: readonly SuiteStepReviewInput[],
): StoredRun['aggregate'] {
  let passed = 0;
  let failed = 0;
  let faulted = 0;
  let errors = 0;
  let warnings = 0;
  for (const step of steps) {
    if (step.summary.outcome === 'passed') passed += 1;
    else if (step.summary.outcome === 'failed') failed += 1;
    else faulted += 1;
    errors += step.summary.verdict?.errors ?? 0;
    warnings += step.summary.verdict?.warnings ?? 0;
  }
  return { steps: steps.length, passed, failed, faulted, errors, warnings };
}

function contextResultMatchesExecutedSteps(input: ProjectSuiteRunInput): boolean {
  const aggregate = input.result.aggregate;
  const expectedAggregate = aggregateExecutedContextSteps(input.internalSteps);
  const summariesMatch =
    input.result.steps.length === input.internalSteps.length &&
    input.result.steps.every((summary, ordinal) => {
      const executed = input.internalSteps[ordinal]?.summary;
      return (
        summary.tool === executed?.tool &&
        summary.stableId === executed?.stableId &&
        summary.command === executed?.command &&
        summary.exitCode === executed?.exitCode &&
        summary.outcome === executed?.outcome &&
        summary.kind === executed?.kind
      );
    });
  if (
    !summariesMatch ||
    input.result.steps.length !== BUILT_IN_AGENT_CONTEXT_PLANES.length ||
    aggregate === undefined
  ) {
    return false;
  }
  return (
    aggregate.steps === expectedAggregate.steps &&
    aggregate.passed === expectedAggregate.passed &&
    aggregate.failed === expectedAggregate.failed &&
    aggregate.faulted === expectedAggregate.faulted &&
    aggregate.errors === 0 &&
    aggregate.warnings === 0 &&
    expectedAggregate.errors === 0 &&
    expectedAggregate.warnings === 0 &&
    input.result.exitCode ===
      (input.result.contextManifest?.readiness === 'unavailable' || expectedAggregate.faulted > 0
        ? EXIT_CODES.RUNTIME_ERROR
        : EXIT_CODES.SUCCESS)
  );
}

function contextPlanesMatchLedgerIdentity(
  manifest: TaskContextManifest,
  identity: SuiteLedgerIdentity,
): boolean {
  return manifest.planes.every((plane) => {
    const ordinal = BUILT_IN_AGENT_CONTEXT_PLANES.findIndex(
      (authority) => authority.kind === plane.kind,
    );
    const authority = BUILT_IN_AGENT_CONTEXT_PLANES[ordinal];
    const stepIdentity = identity.steps[ordinal];
    return (
      ordinal >= 0 &&
      authority !== undefined &&
      stepIdentity !== undefined &&
      plane.producer.toolId === BUILT_IN_GRAPH_TOOL_ID &&
      plane.producer.command === authority.command &&
      plane.step.runId === identity.runId &&
      plane.step.stepId === stepIdentity.id &&
      plane.step.logicalStepKey === stepIdentity.logicalStepKey &&
      plane.step.ordinal === stepIdentity.ordinal &&
      plane.step.attempt === stepIdentity.attempt
    );
  });
}

/** Build a validated parent Run + ordered RunSteps without datastore I/O. */
export function projectSuiteRun(input: ProjectSuiteRunInput): SuiteRunLedgerProjection {
  if (!contextManifestMatchesHostAuthority(input)) {
    throw new TypeError('The task-context manifest does not match host persistence authority.');
  }
  const runId = input.identity.runId;
  const run: StoredRun = {
    id: runId,
    name: input.result.suite,
    source: input.source === 'built-in' ? 'built-in-suite' : 'configured-suite',
    ...(input.correlationRunId === undefined ? {} : { correlationRunId: input.correlationRunId }),
    cwd: input.cwd,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.result.durationMs,
    exitCode: input.result.exitCode,
    aggregate: input.result.aggregate ?? {
      steps: input.result.steps.length,
      passed: 0,
      failed: 0,
      faulted: 0,
      errors: 0,
      warnings: 0,
    },
    ...(input.result.scope === undefined ? {} : { scope: input.result.scope }),
    ...(input.result.reviewBrief === undefined ? {} : { reviewBrief: input.result.reviewBrief }),
    ...(input.result.contextManifest === undefined
      ? {}
      : { contextManifest: input.result.contextManifest }),
    legacySuiteRunId: input.result.suiteRunId,
    cliVersion: CLI_VERSION,
  };
  const steps = input.internalSteps.map((step, position): StoredRunStep => {
    const summary = step.summary;
    const effectiveArgs = persistedEffectiveArgs(
      step.effectiveArgs,
      input.source === 'built-in' && input.result.suite === BUILT_IN_AGENT_CONTEXT_SUITE_NAME,
    );
    const identity = input.identity.steps[position];
    if (identity?.ordinal !== step.stepIndex) {
      throw new Error('Suite ledger identity does not match the executed step order.');
    }
    const evidence =
      step.evidenceSnapshots === undefined
        ? (step.ledgerEvidence ?? projectEnvelopeEvidence(step.capturedEnvelope))
        : projectEvidenceSnapshotEvidence(step.evidenceSnapshots);
    return {
      id: identity.id,
      runId,
      logicalStepKey: identity.logicalStepKey,
      ordinal: identity.ordinal,
      attempt: identity.attempt,
      tool: summary.tool,
      command: summary.command,
      stableId: summary.stableId,
      ...(effectiveArgs === undefined ? {} : { effectiveArgs }),
      exitCode: summary.exitCode,
      outcome: summary.outcome,
      durationMs: summary.durationMs,
      ...(summary.verdict === undefined ? {} : { verdictSummary: summary.verdict }),
      ...(step.sessionId === undefined ? {} : { sessionId: step.sessionId }),
      ...(evidence === undefined ? {} : { evidence }),
    };
  });
  return {
    evidence: { run, steps },
    ...(input.persistencePrecondition === undefined
      ? {}
      : { precondition: input.persistencePrecondition }),
  };
}
