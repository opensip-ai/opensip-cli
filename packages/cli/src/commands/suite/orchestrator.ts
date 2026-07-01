import { performance } from 'node:perf_hooks';

import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  currentLogger,
  currentScope,
  generatePrefixedId,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';

import { buildMaybeDispatchExternal } from '../../bootstrap/bind-external-dispatch.js';
import { bindToolCliContext } from '../../bootstrap/bind-tool-context.js';
import { runWithSuiteRunContext, type RunActionHooks } from '../../bootstrap/run-plane.js';
import { assembleOptsFromSpec } from '../assemble-opts.js';
import { dispatchOutput } from '../mount-command-spec.js';

import { createCapturingContext } from './capturing-context.js';
import { validateSuite, type ValidatedSuite, type ValidatedSuiteStep } from './validate-suite.js';

import type { SuiteDefinition } from '@opensip-cli/config';
import type { SuiteRunResult, SuiteStepSummary } from '@opensip-cli/contracts';

class DirectProcessExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

export interface RunSuiteInput {
  readonly name: string;
  readonly suite: SuiteDefinition;
  readonly tools: readonly Tool[];
  readonly ctx: ToolCliContext;
  readonly runActionHooks: RunActionHooks;
  readonly suiteOpts: Readonly<Record<string, unknown>>;
}

export async function runSuite(input: RunSuiteInput): Promise<SuiteRunResult> {
  const suite = validateSuite({
    name: input.name,
    suite: input.suite,
    tools: input.tools,
  });
  const suiteRunId = generatePrefixedId('suite');
  const started = performance.now();
  const log = currentLogger();

  log.info?.({
    evt: 'cli.suite.run.start',
    suite: suite.name,
    suiteRunId,
    stepCount: suite.steps.length,
  });

  const steps = await runWithSuiteRunContext({ suiteRunId, suiteName: suite.name }, () =>
    runStepsSerially({
      suite,
      suiteRunId,
      ctx: input.ctx,
      runActionHooks: input.runActionHooks,
      suiteOpts: input.suiteOpts,
    }),
  );
  const exitCode = Math.max(0, ...steps.map((step) => step.exitCode));
  const aggregate = deriveSuiteAggregate(steps);
  const durationMs = Math.max(0, performance.now() - started);

  log.info?.({
    evt: 'cli.suite.run.complete',
    suite: suite.name,
    suiteRunId,
    exitCode,
    durationMs,
    aggregate,
  });

  return {
    type: 'suite-run',
    suite: suite.name,
    suiteRunId,
    exitCode,
    durationMs,
    aggregate,
    steps,
  };
}

export function deriveSuiteAggregate(
  steps: readonly SuiteStepSummary[],
): SuiteRunResult['aggregate'] {
  let passed = 0;
  let failed = 0;
  let faulted = 0;
  let errors = 0;
  let warnings = 0;

  for (const step of steps) {
    const verdict = step.verdict;
    if (step.error !== undefined) {
      faulted += 1;
    } else if (step.exitCode !== EXIT_CODES.SUCCESS || verdict?.passed === false) {
      failed += 1;
    } else if (verdict?.passed === true) {
      passed += 1;
    }
    errors += verdict?.errors ?? 0;
    warnings += verdict?.warnings ?? 0;
  }

  return {
    steps: steps.length,
    passed,
    failed,
    faulted,
    errors,
    warnings,
  };
}

async function runStepsSerially(args: {
  readonly suite: ValidatedSuite;
  readonly suiteRunId: string;
  readonly ctx: ToolCliContext;
  readonly runActionHooks: RunActionHooks;
  readonly suiteOpts: Readonly<Record<string, unknown>>;
}): Promise<SuiteStepSummary[]> {
  const summaries: SuiteStepSummary[] = [];
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
        }),
      );
    });
  }

  await chain;
  return summaries;
}

async function runStep(args: {
  readonly suite: ValidatedSuite;
  readonly suiteRunId: string;
  readonly step: ValidatedSuiteStep;
  readonly ctx: ToolCliContext;
  readonly runActionHooks: RunActionHooks;
  readonly suiteOpts: Readonly<Record<string, unknown>>;
}): Promise<SuiteStepSummary> {
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
  // silently aggregated to 0) AND leaked the code into the outer host context — the
  // same isolation the bundled path preserves. (04↔05 regression: external adapter
  // as a suite step.)
  const opts = stepOpts(args.step, args.suiteOpts);
  const hooks: RunActionHooks = {
    ...args.runActionHooks,
    maybeDispatchExternal: buildMaybeDispatchExternal(args.step.tool, capture.context),
  };
  const diagnostics = currentScope()?.diagnostics;
  const log = currentLogger();
  let errorMessage: string | undefined;
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
        hooks.beginRun?.();
        const dispatched = await hooks.maybeDispatchExternal?.(
          args.step.spec.name,
          opts,
          args.step.positionals,
        );
        if (dispatched === true) return capture.getExitCode() ?? EXIT_CODES.SUCCESS;
        const result = await args.step.spec.handler(opts, capture.context);
        hooks.completeRun?.(result);
        await dispatchOutput(result, args.step.spec, opts, args.step.positionals, capture.context);
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
    // @fitness-ignore-next-line exit-code-correctness -- suite steps convert thrown step failures into a non-zero step summary; runSuite later returns the max step exit code.
  } catch (error) {
    exitCode = EXIT_CODES.RUNTIME_ERROR;
    errorMessage = error instanceof Error ? error.message : String(error);
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
  const verdict =
    envelopeStats === undefined
      ? undefined
      : {
          passed: envelopeStats.verdict.passed,
          errors: envelopeStats.verdict.summary.errors,
          warnings: envelopeStats.verdict.summary.warnings,
          findings: envelopeStats.findings,
        };

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

  return {
    tool: args.step.tool.metadata.name,
    stableId: args.step.tool.metadata.id,
    command: args.step.spec.name,
    exitCode,
    durationMs,
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
    ...(verdict === undefined ? {} : { verdict }),
  };
}

function stepOpts(
  step: ValidatedSuiteStep,
  suiteOpts: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const assembled = assembleOptsFromSpec({
    options: step.spec.options,
    suppliedValues: step.args,
  }).opts;
  const common: Record<string, unknown> = {};
  for (const key of step.spec.commonFlags) {
    const value = suiteOpts[key];
    if (value !== undefined) common[key] = value;
  }
  if (step.spec.commonFlags.includes('cwd') && common.cwd === undefined) {
    common.cwd = process.cwd();
  }
  return { ...common, ...assembled, _args: step.positionals };
}

async function withProcessExitGuard(
  fn: () => Promise<number>,
  onDirectExit: (code: number) => void,
): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- process.exit has no `this` contract; identity must be restored after the guard.
  const original = process.exit;
  // @fitness-ignore-next-line throws-documentation -- this private guard intentionally throws a sentinel so direct process.exit calls become suite step exit codes.
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new DirectProcessExit(typeof code === 'number' ? code : 0);
  };
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DirectProcessExit) {
      onDirectExit(error.code);
      return error.code;
    }
    throw error;
  } finally {
    (process as unknown as { exit: typeof process.exit }).exit = original;
  }
}
