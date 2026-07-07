import { performance } from 'node:perf_hooks';

import {
  deriveOutcome,
  EXIT_CODES,
  type RunOutcome,
  type SuiteStepSummary,
} from '@opensip-cli/contracts';
import { currentLogger, currentScope, type ToolCliContext } from '@opensip-cli/core';

import { buildMaybeDispatchExternal } from '../../bootstrap/bind-external-dispatch.js';
import { bindToolCliContext } from '../../bootstrap/bind-tool-context.js';
import { truncateDerivedMessage } from '../../bootstrap/report-failure.js';
import { assembleOptsFromSpec } from '../assemble-opts.js';
import { runCommandSpecAction } from '../run-command-spec-action.js';

import { BUILT_IN_GRAPH_TOOL_ID } from './built-in-suites.js';
import { createCapturingContext } from './capturing-context.js';
import {
  declaredOptionKeys,
  hasRuntimeSelector,
  propagatedSuiteArgs,
} from './propagated-options.js';
import { verificationFromEnvelope, withProcessExitGuard } from './suite-step-helpers.js';

import type { SuiteStepReviewInput } from './review-brief.js';
import type { ValidatedSuite, ValidatedSuiteStep } from './validate-suite.js';
import type { RunActionHooks } from '../../bootstrap/run-plane.js';

export async function runStepsSerially(args: {
  readonly suite: ValidatedSuite;
  readonly suiteRunId: string;
  readonly ctx: ToolCliContext;
  readonly runActionHooks: RunActionHooks;
  readonly suiteOpts: Readonly<Record<string, unknown>>;
  readonly defaultChanged?: boolean;
  readonly fullScopeFiles?: readonly string[];
}): Promise<SuiteStepReviewInput[]> {
  const summaries: SuiteStepReviewInput[] = [];
  let chain = Promise.resolve();

  for (const step of args.suite.steps) {
    chain = chain.then(async () => {
      summaries.push(
        await runStep({
          suite: args.suite,
          suiteRunId: args.suiteRunId,
          step,
          ctx: args.ctx,
          runActionHooks: args.runActionHooks,
          suiteOpts: args.suiteOpts,
          defaultChanged: args.defaultChanged,
          fullScopeFiles: args.fullScopeFiles,
        }),
      );
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
 * A step is `faulted` when EITHER a runtime issue was caught by the host OR the
 * envelope's own verdict is faulted (a UNIT-level fault — a check that threw —
 * reaches us only through `verdict.faulted`, never through `errorMessage`). The
 * old aggregate tested only the first half, which is why a unit-fault was
 * mislabeled `failed`. With an envelope present, its verdict decides
 * passed/failed; with no envelope and no error, the exit code is the fallback.
 */
export function deriveStepOutcome(input: {
  readonly errorMessage: string | undefined;
  readonly envelopeVerdict: { readonly passed: boolean; readonly faulted?: boolean } | undefined;
  readonly exitCode: number;
}): RunOutcome {
  const envelopeOutcome =
    input.envelopeVerdict === undefined ? undefined : deriveOutcome(input.envelopeVerdict);
  if (input.errorMessage !== undefined || envelopeOutcome === 'faulted') return 'faulted';
  return envelopeOutcome ?? (input.exitCode === EXIT_CODES.SUCCESS ? 'passed' : 'failed');
}

async function runStep(args: {
  readonly suite: ValidatedSuite;
  readonly suiteRunId: string;
  readonly step: ValidatedSuiteStep;
  readonly ctx: ToolCliContext;
  readonly runActionHooks: RunActionHooks;
  readonly suiteOpts: Readonly<Record<string, unknown>>;
  readonly defaultChanged?: boolean;
  readonly fullScopeFiles?: readonly string[];
}): Promise<SuiteStepReviewInput> {
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
  const hooks: RunActionHooks = {
    ...args.runActionHooks,
    maybeDispatchExternal: buildMaybeDispatchExternal(
      args.step.tool,
      capture.context,
      args.runActionHooks,
    ),
  };
  const diagnostics = currentScope()?.diagnostics;
  const log = currentLogger();
  let errorMessage: string | undefined;
  let errorCode: string | undefined;
  let exitCode: number = EXIT_CODES.SUCCESS;
  try {
    diagnostics?.event('execute', 'debug', `suite step '${args.step.spec.name}' started`, {
      suite: args.suite.name,
      suiteRunId: args.suiteRunId,
      tool: args.step.tool.metadata.id,
      command: args.step.spec.name,
    });
    exitCode = await withProcessExitGuard(
      async () => {
        hooks.resetRun?.();
        await runCommandSpecAction(
          args.step.spec,
          opts,
          args.step.positionals,
          capture.context,
          hooks,
        );
        return capture.getExitCode() ?? EXIT_CODES.SUCCESS;
      },
      (code) => {
        // A bundled step called `process.exit(code)` directly: route the code into
        // the capture's last-write-wins slot (the single per-step exit source of
        // truth) just as `setExitCode` would, then record it.
        capture.context.setExitCode(code);
        log.warn?.({
          evt: 'cli.suite.run.step',
          suite: args.suite.name,
          suiteRunId: args.suiteRunId,
          tool: args.step.tool.metadata.id,
          command: args.step.spec.name,
          exitCode: code,
          msg: 'Bundled step called process.exit directly; captured as step verdict.',
        });
      },
    );
    diagnostics?.event('execute', 'debug', `suite step '${args.step.spec.name}' completed`, {
      suite: args.suite.name,
      suiteRunId: args.suiteRunId,
      tool: args.step.tool.metadata.id,
      command: args.step.spec.name,
      exitCode,
    });
    diagnostics?.counter('suite.steps.completed', 1);
    const reportedFailure = capture.getReportedFailure();
    errorMessage = reportedFailure?.message;
    errorCode = reportedFailure?.code;
  } catch (error) {
    exitCode = EXIT_CODES.RUNTIME_ERROR;
    errorMessage = truncateDerivedMessage(error instanceof Error ? error.message : String(error));
    diagnostics?.event('execute', 'error', `suite step '${args.step.spec.name}' failed`, {
      suite: args.suite.name,
      suiteRunId: args.suiteRunId,
      tool: args.step.tool.metadata.id,
      command: args.step.spec.name,
      exitCode,
      error: errorMessage,
    });
    log.error?.({
      evt: 'cli.suite.run.step.error',
      suite: args.suite.name,
      suiteRunId: args.suiteRunId,
      tool: args.step.tool.metadata.id,
      command: args.step.spec.name,
      error: errorMessage,
    });
  }
  const durationMs = Math.max(0, performance.now() - started);
  const envelopeStats = capture.getEnvelopeStats();
  const capturedEnvelope = capture.getEnvelope();
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
  const outcome = deriveStepOutcome({
    errorMessage,
    envelopeVerdict: envelopeStats?.verdict,
    exitCode,
  });

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

  const summary: SuiteStepSummary = {
    tool: args.step.tool.metadata.name,
    stableId: args.step.tool.metadata.id,
    command: args.step.spec.name,
    exitCode,
    durationMs,
    outcome,
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(verdict === undefined ? {} : { verdict }),
    ...(verification === undefined ? {} : { verification }),
  };
  return {
    stepIndex: args.step.index,
    summary,
    ...(capturedEnvelope === undefined ? {} : { capturedEnvelope }),
  };
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
  return { ...common, ...assembled, ...propagated, ...fullScopeFilesArg, _args: step.positionals };
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
