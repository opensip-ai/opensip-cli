import { performance } from 'node:perf_hooks';

import {
  deriveOutcome,
  EXIT_CODES,
  type RunOutcome,
  type SuiteStepSummary,
} from '@opensip-cli/contracts';
import {
  commandProducesVerdict,
  currentLogger,
  type ToolCliContext,
  type EvidenceSnapshotContribution,
} from '@opensip-cli/core';

import { buildMaybeDispatchExternal } from '../../bootstrap/bind-external-dispatch.js';
import { bindToolCliContext } from '../../bootstrap/bind-tool-context.js';
import { assembleOptsFromSpec } from '../assemble-opts.js';
import { projectLedgerArgs } from '../run-ledger-projection.js';

import { BUILT_IN_GRAPH_TOOL_ID } from './built-in-suites.js';
import { createCapturingContext } from './capturing-context.js';
import {
  declaredOptionKeys,
  hasRuntimeSelector,
  propagatedSuiteArgs,
} from './propagated-options.js';
import {
  assertStepCompletion,
  capabilityBoundCompleteRun,
  executeStep,
  type RunStepInput,
  type SuiteCompletionObservation,
} from './suite-step-execution.js';
import { verificationFromEnvelope } from './suite-step-helpers.js';

import type { SuiteStepReviewInput } from './review-brief.js';
import type { ValidatedSuite, ValidatedSuiteStep } from './validate-suite.js';
import type { RunActionHooks } from '../../bootstrap/run-plane.js';

/** A step's lifecycle transition, emitted so a live view can drive the checklist. */
export type SuiteStepEvent =
  | { readonly phase: 'start'; readonly index: number }
  | {
      readonly phase: 'done';
      readonly index: number;
      readonly summary: SuiteStepSummary;
    };

export async function runStepsSerially(args: {
  readonly suite: ValidatedSuite;
  readonly suiteRunId: string;
  readonly ctx: ToolCliContext;
  readonly runActionHooks: RunActionHooks;
  readonly suiteOpts: Readonly<Record<string, unknown>>;
  readonly defaultChanged?: boolean;
  readonly fullScopeFiles?: readonly string[];
  /** Optional lifecycle sink (the suite live view wires this to progress events). */
  readonly onStepEvent?: (event: SuiteStepEvent) => void;
}): Promise<SuiteStepReviewInput[]> {
  const summaries: SuiteStepReviewInput[] = [];
  let chain = Promise.resolve();

  // @sequential-ok — suite steps run strictly one at a time (shared project
  // scope, ordered evidence); this promise chain IS the concurrency-1 bound.
  for (const step of args.suite.steps) {
    chain = chain.then(async () => {
      args.onStepEvent?.({ phase: 'start', index: step.index });
      const review = await runStep({
        suite: args.suite,
        suiteRunId: args.suiteRunId,
        step,
        ctx: args.ctx,
        runActionHooks: args.runActionHooks,
        suiteOpts: args.suiteOpts,
        defaultChanged: args.defaultChanged,
        fullScopeFiles: args.fullScopeFiles,
      });
      summaries.push(review);
      args.onStepEvent?.({
        phase: 'done',
        index: step.index,
        summary: review.summary,
      });
    });
  }

  await chain;
  return summaries;
}

/**
 * Derive a suite step's authoritative 3-way {@link RunOutcome} from the two
 * runtime signals the runner observes — the host-caught `errorMessage` (a thrown
 * step OR a reportFailure) and the emitted envelope's verdict.
 *
 * The emitted envelope's verdict is AUTHORITATIVE when present: it already
 * carries `faulted` for a UNIT-level fault (a check that threw), and a
 * report-DELIVERY failure on a run that DID produce results is orthogonal to the
 * analysis outcome (it rides the exit code, ADR-0008) — so it does not override a
 * passing/failing verdict into `faulted`. A host-caught error decides the outcome
 * ONLY when the step produced NO envelope at all (a thrown command,
 * ConfigurationError, or ToolError before results, ADR-0060) — that reads
 * `faulted`. With neither an envelope nor an error, the exit code is the fallback.
 *
 * This distinction is load-bearing for the suite exit: an envelope-backed fault
 * (a check crashed, `verdict` present) is a NON-blocking "result unknown", while
 * a no-envelope fault (the tool/step itself crashed) keeps its ADR-0020 exit
 * taxonomy and blocks — see the `isNonBlockingFault` gate in `orchestrator.ts`.
 */
export function deriveStepOutcome(input: {
  readonly errorMessage: string | undefined;
  readonly envelopeVerdict: { readonly passed: boolean; readonly faulted?: boolean } | undefined;
  readonly exitCode: number;
}): RunOutcome {
  if (input.envelopeVerdict !== undefined) return deriveOutcome(input.envelopeVerdict);
  if (input.errorMessage !== undefined) return 'faulted';
  return input.exitCode === EXIT_CODES.SUCCESS ? 'passed' : 'failed';
}

/** Closed readiness projection for a generic evidence-producing suite step. */
export function evidenceStepReadiness(
  snapshots: readonly EvidenceSnapshotContribution[],
): NonNullable<SuiteStepSummary['readiness']> {
  if (
    snapshots.length === 0 ||
    snapshots.some((snapshot) => snapshot.status === 'failed' || snapshot.status === 'cancelled')
  ) {
    return 'unavailable';
  }
  return snapshots.some(
    (snapshot) =>
      snapshot.status === 'partial' ||
      snapshot.status === 'unsupported' ||
      snapshot.freshness.status !== 'current' ||
      snapshot.coverage.status !== 'complete',
  )
    ? 'degraded'
    : 'ready';
}

function stepOutcome(input: {
  readonly kind: ValidatedSuiteStep['kind'];
  readonly errorMessage: string | undefined;
  readonly evidenceUnavailable: boolean;
  readonly envelopeVerdict: { readonly passed: boolean; readonly faulted?: boolean } | undefined;
  readonly exitCode: number;
}): RunOutcome {
  if (input.kind === 'evidence' && input.errorMessage === undefined) {
    return input.evidenceUnavailable ? 'faulted' : 'passed';
  }
  return deriveStepOutcome({
    errorMessage: input.errorMessage,
    envelopeVerdict: input.envelopeVerdict,
    exitCode: input.exitCode,
  });
}

function buildStepSummary(input: {
  readonly args: RunStepInput;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly outcome: RunOutcome;
  readonly readiness: SuiteStepSummary['readiness'];
  readonly errorMessage: string | undefined;
  readonly errorCode: string | undefined;
  readonly verdict: SuiteStepSummary['verdict'];
  readonly verification: SuiteStepSummary['verification'];
}): SuiteStepSummary {
  return {
    tool: input.args.step.tool.metadata.name,
    stableId: input.args.step.tool.metadata.id,
    command: input.args.step.spec.name,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    outcome: input.outcome,
    kind: input.args.step.kind,
    ...(input.readiness === undefined ? {} : { readiness: input.readiness }),
    ...(input.errorMessage === undefined ? {} : { error: input.errorMessage }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
    ...(input.verification === undefined ? {} : { verification: input.verification }),
  };
}

function buildStepReview(input: {
  readonly args: RunStepInput;
  readonly summary: SuiteStepSummary;
  readonly opts: Readonly<Record<string, unknown>>;
  readonly sessionId: string | undefined;
  readonly capturedEnvelope: ReturnType<ReturnType<typeof createCapturingContext>['getEnvelope']>;
  readonly evidenceSnapshots: readonly EvidenceSnapshotContribution[];
}): SuiteStepReviewInput {
  const effectiveArgs = projectLedgerArgs(input.opts);
  return {
    stepIndex: input.args.step.index,
    summary: input.summary,
    ...(effectiveArgs === undefined ? {} : { effectiveArgs }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.capturedEnvelope === undefined ? {} : { capturedEnvelope: input.capturedEnvelope }),
    ...(input.evidenceSnapshots.length === 0 ? {} : { evidenceSnapshots: input.evidenceSnapshots }),
  };
}

async function runStep(args: RunStepInput): Promise<SuiteStepReviewInput> {
  const started = performance.now();
  const bound = bindToolCliContext(args.step.tool, args.ctx);
  const capture = createCapturingContext(bound);
  // ADR-0054 out-of-process dispatch must run through the CAPTURING context, not
  // the raw bound ctx. For an external-provenance step the worker replay
  // (`replayResult`) calls `ctx.setExitCode` with the tool's verdict exit code;
  // binding the hook to `capture.context` routes that into the capture's exit slot
  // (`capture.getExitCode()`) so the external step participates in the suite
  // worst-of aggregation exactly like the in-process handler (which already runs
  // against `capture.context`). Binding to `bound` instead dropped the external
  // step's exit code (it never reached the slot, so a findings/regression verdict
  // silently aggregated to 0) AND leaked the code into the outer host context - the
  // same isolation the bundled path preserves. (04<->05 regression: external adapter
  // as a suite step.)
  const opts = stepOpts(args.step, args.suiteOpts, args.defaultChanged, args.fullScopeFiles);
  const completionObservation: SuiteCompletionObservation = {
    returnedEvidence: false,
    returnedEnvelope: false,
    returnedSession: false,
  };
  const hooks: RunActionHooks = {
    ...args.runActionHooks,
    completeRun: capabilityBoundCompleteRun(
      args.step,
      args.runActionHooks.completeRun,
      completionObservation,
    ),
    maybeDispatchExternal: buildMaybeDispatchExternal(
      args.step.tool,
      capture.context,
      args.runActionHooks,
    ),
  };
  const log = currentLogger();
  const executed = await executeStep({ args, opts, capture, hooks });
  const durationMs = Math.max(0, performance.now() - started);
  const rawEnvelopeStats = capture.getEnvelopeStats();
  const rawCapturedEnvelope = capture.getEnvelope();
  const rawSessionId = hooks.currentSessionId?.();
  const rawEvidenceSnapshots = hooks.currentEvidenceSnapshots?.() ?? [];
  const capabilityMismatch =
    args.step.kind === 'evidence'
      ? rawCapturedEnvelope !== undefined ||
        rawSessionId !== undefined ||
        completionObservation.returnedEnvelope ||
        completionObservation.returnedSession
      : rawEvidenceSnapshots.length > 0 || completionObservation.returnedEvidence;
  const completion = assertStepCompletion({
    executed,
    producesVerdict: commandProducesVerdict(args.step.spec),
    hasSession: rawSessionId !== undefined,
    hasEnvelope: rawCapturedEnvelope !== undefined,
    evidenceStep: args.step.kind === 'evidence',
    evidenceCount: rawEvidenceSnapshots.length,
    capabilityMismatch,
  });
  const { errorMessage, errorCode } = completion;
  // A capability mismatch invalidates the whole returned proof object. Do not
  // let either leg enter the review brief, task-context manifest, or run ledger.
  const capturedEnvelope = capabilityMismatch ? undefined : rawCapturedEnvelope;
  const sessionId = capabilityMismatch ? undefined : rawSessionId;
  const evidenceSnapshots = capabilityMismatch ? [] : rawEvidenceSnapshots;
  const envelopeStats = capabilityMismatch ? undefined : rawEnvelopeStats;
  const verification = verificationFromEnvelope(capturedEnvelope);
  const verdict =
    envelopeStats === undefined
      ? undefined
      : {
          passed: envelopeStats.verdict.passed,
          errors: envelopeStats.verdict.summary.errors,
          warnings: envelopeStats.verdict.summary.warnings,
          findings: envelopeStats.findings,
        };

  // The step's authoritative 3-way outcome — the single source of truth shared
  // with single-tool runs (see {@link deriveStepOutcome}).
  const evidenceUnavailable = evidenceSnapshots.some(
    (snapshot) => snapshot.status === 'failed' || snapshot.status === 'cancelled',
  );
  const exitCode = evidenceUnavailable
    ? Math.max(completion.exitCode, EXIT_CODES.RUNTIME_ERROR)
    : completion.exitCode;
  const outcome = stepOutcome({
    kind: args.step.kind,
    errorMessage,
    evidenceUnavailable,
    envelopeVerdict: envelopeStats?.verdict,
    exitCode,
  });
  const readiness =
    args.step.kind === 'evidence' ? evidenceStepReadiness(evidenceSnapshots) : undefined;

  log.info?.({
    evt: 'cli.suite.run.step',
    suite: args.suite.name,
    suiteRunId: args.suiteRunId,
    tool: args.step.tool.metadata.id,
    command: args.step.spec.name,
    exitCode,
    durationMs,
    ...(verdict === undefined
      ? {}
      : {
          verdict: {
            passed: verdict.passed,
            findings: verdict.findings,
          },
        }),
  });

  const summary = buildStepSummary({
    args,
    exitCode,
    durationMs,
    outcome,
    readiness,
    errorMessage,
    errorCode,
    verdict,
    verification,
  });
  return buildStepReview({
    args,
    summary,
    opts,
    sessionId,
    capturedEnvelope,
    evidenceSnapshots,
  });
}

function stepOpts(
  step: ValidatedSuiteStep,
  suiteOpts: Readonly<Record<string, unknown>>,
  defaultChanged?: boolean,
  fullScopeFiles?: readonly string[],
): Record<string, unknown> {
  const assembled = assembleOptsFromSpec({
    options: step.spec.options,
    suppliedValues: step.args,
  }).opts;
  const propagated = propagatedSuiteArgs({ step, suiteOpts, defaultChanged });
  const fullScopeFilesArg = builtInGraphImpactFullScopeFiles(step, suiteOpts, fullScopeFiles);
  const common: Record<string, unknown> = {};
  for (const key of step.spec.commonFlags) {
    const value = suiteOpts[key];
    if (value !== undefined) common[key] = value;
  }
  if (step.spec.commonFlags.includes('cwd') && common.cwd === undefined) {
    common.cwd = process.cwd();
  }
  return {
    ...common,
    ...assembled,
    ...propagated,
    ...fullScopeFilesArg,
    _args: step.positionals,
  };
}

function builtInGraphImpactFullScopeFiles(
  step: ValidatedSuiteStep,
  suiteOpts: Readonly<Record<string, unknown>>,
  fullScopeFiles: readonly string[] | undefined,
): Record<string, unknown> {
  if (fullScopeFiles === undefined || fullScopeFiles.length === 0) return {};
  if (step.tool.metadata.id !== BUILT_IN_GRAPH_TOOL_ID || step.spec.name !== 'impact') return {};
  if (hasRuntimeSelector(suiteOpts) || Object.prototype.hasOwnProperty.call(step.args, 'files')) {
    return {};
  }
  if (!declaredOptionKeys(step).has('files')) return {};
  return { files: fullScopeFiles };
}
