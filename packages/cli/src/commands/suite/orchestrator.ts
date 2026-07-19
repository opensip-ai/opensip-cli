import { performance } from 'node:perf_hooks';

import {
  EXIT_CODES,
  type SuiteRunResult,
  type SuiteRunScope,
  type SuiteStepSummary,
} from '@opensip-cli/contracts';
import {
  currentLogger,
  currentScope,
  generatePrefixedId,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';

import { runWithSuiteRunContext, type RunActionHooks } from '../../bootstrap/run-plane.js';

import { type SuiteSource } from './built-in-suites.js';
import { planSuiteReportEffect } from './open-suite-report.js';
import {
  deriveSuiteAggregate,
  loadSuiteStepCapabilities,
  resolveBuiltInAuditFullScopeFiles,
} from './orchestration-helpers.js';
import { buildReviewBrief } from './review-brief-builder.js';
import {
  allocateSuiteLedgerIdentity,
  projectSuiteRun,
  type SuiteLedgerIdentity,
} from './run-ledger-persist.js';
import { resolveSuiteScope } from './suite-scope.js';
import { runStepsSerially, type SuiteStepEvent } from './suite-step-runner.js';
import {
  logTaskContextManifest,
  prepareTaskContext,
  resultWithPersistence,
  taskContextManifestFor,
  taskContextPointersAvailable,
} from './task-context-orchestration.js';
import { validateSuite, type ValidatedSuite } from './validate-suite.js';

import type { SuiteStepReviewInput } from './review-brief.js';
import type { SuiteDefinition } from '@opensip-cli/config';

export { deriveSuiteAggregate } from './orchestration-helpers.js';

export interface RunSuiteInput {
  readonly name: string;
  readonly suite: SuiteDefinition;
  readonly source?: SuiteSource;
  readonly tools: readonly Tool[];
  readonly ctx: ToolCliContext;
  readonly runActionHooks: RunActionHooks;
  readonly suiteOpts: Readonly<Record<string, unknown>>;
  readonly defaultChanged?: boolean;
  /** Optional step-lifecycle sink — the suite live view wires this to progress events. */
  readonly onStepEvent?: (event: SuiteStepEvent) => void;
}

type SuiteEvidenceOwner = ReturnType<NonNullable<RunActionHooks['createNestedEvidenceOwner']>>;

interface SuiteEvidenceSeam {
  readonly owner: SuiteEvidenceOwner;
  readonly finalize: NonNullable<RunActionHooks['finalizeEvidenceOwner']>;
  readonly discard: NonNullable<RunActionHooks['discardEvidenceOwner']>;
  readonly replaceReport: NonNullable<RunActionHooks['replaceEvidenceOwnerReportEffect']>;
}

/** @throws {TypeError} When the host provides only part of the atomic evidence seam. */
function createSuiteEvidenceSeam(hooks: RunActionHooks): SuiteEvidenceSeam {
  const create = hooks.createNestedEvidenceOwner;
  const finalize = hooks.finalizeEvidenceOwner;
  const discard = hooks.discardEvidenceOwner;
  const replaceReport = hooks.replaceEvidenceOwnerReportEffect;
  if (
    create === undefined ||
    finalize === undefined ||
    discard === undefined ||
    replaceReport === undefined
  ) {
    throw new TypeError('The host supplied an incomplete atomic suite evidence seam.');
  }
  return { owner: create(), finalize, discard, replaceReport };
}

function contextPersistencePrecondition(manifest: SuiteRunResult['contextManifest']): {
  readonly persistencePrecondition?: () => boolean;
} {
  if (manifest === undefined || manifest.readiness === 'unavailable') return {};
  return {
    persistencePrecondition: () => taskContextPointersAvailable(manifest),
  };
}

function logSuiteScope(
  log: ReturnType<typeof currentLogger>,
  suiteName: string,
  suiteRunId: string,
  scope: SuiteRunScope,
  stepCount: number,
): void {
  log.info?.({
    evt: 'cli.suite.run.start',
    suite: suiteName,
    suiteRunId,
    stepCount,
  });
  log.debug?.({
    evt: 'cli.suite.scope.resolved',
    suite: suiteName,
    suiteRunId,
    mode: scope.mode,
    source: scope.source,
    ...(scope.changedFiles === undefined ? {} : { changedFiles: scope.changedFiles }),
    ...(scope.ref === undefined ? {} : { ref: scope.ref }),
  });
  if (scope.source === 'fallback') {
    log.warn?.({
      evt: 'cli.suite.scope.fallback',
      suite: suiteName,
      suiteRunId,
      reason: scope.notice,
    });
  }
}

function computeSuiteExitCode(
  steps: readonly SuiteStepSummary[],
  failOnFault: boolean,
  contextUnavailable: boolean,
): number {
  // Worst-of suite exit is deliberately a numeric `Math.max` over the ADR-0020
  // code space (ratified in ADR-0093 / ADR-0100 — see ADR-0131): any failing
  // step fails the suite. After Tasks 1.2/1.3 every step exit source (setExitCode,
  // deliverSignals, reportFailure, emitError, process.exit) writes the per-step
  // capture slot, so `step.exitCode` is the single source of truth here — no step
  // touches the host holder mid-run for this aggregate to miss.
  //
  // A CHECK-level runtime fault (a unit threw but the tool still produced an
  // envelope — `verdict` present) is "result unknown" and NON-blocking by default
  // (#2 fault taxonomy): its exit is excluded from the worst-of so a crashed check
  // doesn't fail the suite like a findings failure does — the fault is still
  // raised in the aggregate counts + review brief. A STEP/APP-level failure (NO
  // envelope: a thrown command, ConfigurationError, or ToolError before results,
  // ADR-0060) keeps its ADR-0020 exit taxonomy and still blocks. `failOnFault`
  // (suite execution policy, default false) opts every fault back into blocking.
  const isNonBlockingFault = (step: SuiteStepSummary): boolean =>
    step.outcome === 'faulted' && step.verdict !== undefined;
  const blockingSteps = failOnFault ? steps : steps.filter((step) => !isNonBlockingFault(step));
  let exitCode = Math.max(0, ...blockingSteps.map((step) => step.exitCode));
  if (contextUnavailable && failOnFault) {
    exitCode = Math.max(exitCode, EXIT_CODES.RUNTIME_ERROR);
  }
  return exitCode;
}

export async function runSuite(input: RunSuiteInput): Promise<SuiteRunResult> {
  const suite = validateSuite({
    name: input.name,
    suite: input.suite,
    tools: input.tools,
  });
  const suiteRunId = generatePrefixedId('suite');
  const evidence = createSuiteEvidenceSeam(input.runActionHooks);
  try {
    return await runWithSuiteRunContext(
      {
        suiteRunId,
        suiteName: suite.name,
        evidenceOwner: evidence.owner,
      },
      () => runSuiteWithinOwner(input, suite, suiteRunId, evidence),
    );
  } catch (error) {
    // Even failures before parent projection must pass through the one owner
    // finalizer so retention and closed cleanup run exactly once. A rejecting
    // precondition guarantees that staged children cannot commit alone.
    await rejectSuiteEvidence(evidence);
    throw error;
  } finally {
    try {
      evidence.discard(evidence.owner);
    } finally {
      // The last child invocation still references the nested owner after its
      // atomic finalizer. Clear only that invocation-local lifecycle so the next
      // command cannot observe a stale child identity.
      input.runActionHooks.resetRun?.();
    }
  }
}

async function runSuiteWithinOwner(
  input: RunSuiteInput,
  suite: ValidatedSuite,
  suiteRunId: string,
  evidence: SuiteEvidenceSeam,
): Promise<SuiteRunResult> {
  const started = performance.now();
  const startedAt = new Date();
  const log = currentLogger();
  const requestedCwd =
    typeof input.suiteOpts.cwd === 'string' ? input.suiteOpts.cwd : process.cwd();
  const context = await prepareTaskContext(input, suite, requestedCwd);
  const cwd = context.cwd;
  const suiteOpts = context.aggregates ? { ...input.suiteOpts, cwd } : input.suiteOpts;
  const scope = resolveSuiteScope({
    cwd,
    suiteOpts,
    defaultChanged: input.defaultChanged === true,
  });

  // When scope resolves to full (explicit --full or fallback from failed
  // changed-file resolution), force full-mode step propagation so failed
  // selectors (changed/since) are not re-sent and graph-impact full-file
  // injection is not blocked by hasRuntimeSelector.
  const stepSuiteOpts: Record<string, unknown> =
    scope.mode === 'full' ? { ...suiteOpts, full: true } : suiteOpts;

  logSuiteScope(log, suite.name, suiteRunId, scope, suite.steps.length);

  await loadSuiteStepCapabilities(suite, context.aggregates ? cwd : undefined);

  const internalSteps = await runStepsSerially({
    suite,
    suiteRunId,
    ctx: input.ctx,
    runActionHooks: input.runActionHooks,
    suiteOpts: stepSuiteOpts,
    defaultChanged: scope.mode === 'changed' && scope.source === 'default',
    fullScopeFiles: resolveBuiltInAuditFullScopeFiles(cwd, {
      defaultChanged: input.defaultChanged === true,
      fullScope: scope.mode === 'full',
    }),
    ...(input.onStepEvent === undefined ? {} : { onStepEvent: input.onStepEvent }),
  });
  const steps = internalSteps.map((step) => step.summary);
  const failOnFault = input.suite.execution?.failOnFault === true;
  const aggregate = deriveSuiteAggregate(steps);
  const reviewBrief = context.aggregates
    ? undefined
    : buildReviewBrief({
        suite: suite.name,
        suiteRunId,
        steps: internalSteps,
        changedFiles: scope.mode === 'changed' ? (scope.changedFiles ?? null) : null,
      });
  if (reviewBrief !== undefined) {
    log.info?.({
      evt: 'cli.suite.brief.built',
      suite: suite.name,
      suiteRunId,
      verdict: reviewBrief.verdict,
      risks: reviewBrief.topRisks.length,
      correlatedRisks: reviewBrief.correlatedRisks?.length ?? 0,
      degraded: reviewBrief.degraded.length,
    });
  }

  const ledgerIdentity = allocateSuiteLedgerIdentity(internalSteps);
  const contextManifest = await taskContextManifestFor({
    preparation: context,
    ledger: ledgerIdentity,
    steps: internalSteps,
  });
  const exitCode = computeSuiteExitCode(
    steps,
    failOnFault,
    contextManifest?.readiness === 'unavailable',
  );
  // Source-end capture is part of the context run's evidence work. Freeze both
  // completion clocks only after it finishes so persisted wall time and the
  // reported monotonic duration cover the same operation boundary.
  const completedAt = new Date();
  const durationMs = Math.max(0, performance.now() - started);

  const baseResult: SuiteRunResult = {
    type: 'suite-run',
    suite: suite.name,
    suiteRunId,
    exitCode,
    durationMs,
    scope,
    aggregate,
    steps,
    ...(reviewBrief === undefined ? {} : { reviewBrief }),
    ...(contextManifest === undefined ? {} : { contextManifest }),
    verbose: input.suiteOpts.verbose === true,
  };

  const committedRunId = await finalizeSuiteEvidence({
    evidence,
    result: baseResult,
    internalSteps,
    source: input.source ?? 'configured',
    cwd,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    identity: ledgerIdentity,
    contextManifest,
    suiteOpts: input.suiteOpts,
    suiteName: suite.name,
    suiteRunId,
    correlationRunId: currentScope()?.runId,
  });

  const result = resultWithPersistence(baseResult, committedRunId);
  logTaskContextManifest(suite.name, result.contextManifest);
  log.info?.({
    evt: 'cli.suite.run.complete',
    suite: suite.name,
    suiteRunId,
    exitCode: result.exitCode,
    durationMs,
    aggregate,
  });
  return result;
}

interface FinalizeSuiteEvidenceInput {
  readonly evidence: SuiteEvidenceSeam;
  readonly result: SuiteRunResult;
  readonly internalSteps: readonly SuiteStepReviewInput[];
  readonly source: SuiteSource;
  readonly cwd: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly identity: SuiteLedgerIdentity;
  readonly contextManifest: SuiteRunResult['contextManifest'];
  readonly suiteOpts: Readonly<Record<string, unknown>>;
  readonly suiteName: string;
  readonly suiteRunId: string;
  readonly correlationRunId?: string;
}

async function finalizeSuiteEvidence(
  input: FinalizeSuiteEvidenceInput,
): Promise<string | undefined> {
  try {
    const projection = projectSuiteRun({
      result: input.result,
      internalSteps: input.internalSteps,
      source: input.source,
      cwd: input.cwd,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      identity: input.identity,
      ...(input.correlationRunId === undefined ? {} : { correlationRunId: input.correlationRunId }),
      ...contextPersistencePrecondition(input.contextManifest),
    });
    const reportEffect = planSuiteReportEffect({
      name: input.suiteName,
      runId: input.identity.runId,
      opts: input.suiteOpts,
    });
    // Parent policy is authoritative even when it resolves to "do not open":
    // clear any request a nested child or external replay attempted to queue.
    if (!input.evidence.replaceReport(input.evidence.owner, reportEffect)) {
      throw new TypeError('The suite evidence owner rejected its parent report policy.');
    }
    const finalized = await input.evidence.finalize(input.evidence.owner, {
      run: projection.evidence,
      ...(projection.precondition === undefined ? {} : { precondition: projection.precondition }),
    });
    return finalized.status === 'committed' && finalized.runId === input.identity.runId
      ? finalized.runId
      : undefined;
  } catch (error) {
    // Projection and custom-host failures must never allow child-only evidence
    // to escape. A rejecting finalization still runs the host's one
    // retention/cleanup pass while committing no prefix.
    await rejectSuiteEvidence(input.evidence);
    currentLogger().warn?.({
      evt: 'cli.run-ledger.suite_record_failed',
      module: 'cli:suite-run-ledger',
      suiteRunId: input.suiteRunId,
      reason: 'ledger-projection-or-finalization-failed',
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return;
  }
}

async function rejectSuiteEvidence(evidence: SuiteEvidenceSeam): Promise<void> {
  try {
    await evidence.finalize(evidence.owner, { precondition: () => false });
  } catch {
    // The outer guaranteed cleanup discards the owner capability.
  }
}
