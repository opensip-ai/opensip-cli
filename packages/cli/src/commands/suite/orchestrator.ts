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
      suiteOpts: input.suiteOpts,
    }),
  );
  const exitCode = Math.max(0, ...steps.map((step) => step.exitCode));
  const durationMs = Math.max(0, performance.now() - started);

  log.info?.({
    evt: 'cli.suite.run.complete',
    suite: suite.name,
    suiteRunId,
    exitCode,
    durationMs,
  });

  return {
    type: 'suite-run',
    suite: suite.name,
    suiteRunId,
    exitCode,
    durationMs,
    steps,
  };
}

async function runStepsSerially(args: {
  readonly suite: ValidatedSuite;
  readonly suiteRunId: string;
  readonly ctx: ToolCliContext;
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
  readonly suiteOpts: Readonly<Record<string, unknown>>;
}): Promise<SuiteStepSummary> {
  const started = performance.now();
  const bound = bindToolCliContext(args.step.tool, args.ctx);
  const capture = createCapturingContext(
    Object.assign(bound, {
      maybeDispatchExternal: buildMaybeDispatchExternal(args.step.tool, bound),
    }),
  );
  const opts = stepOpts(args.step, args.suiteOpts);
  const hooks = capture.context as ToolCliContext & RunActionHooks;
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
        if (dispatched === true) return maxExit(capture.exitCodes);
        const result = await args.step.spec.handler(opts, capture.context);
        hooks.completeRun?.(result);
        await dispatchOutput(result, args.step.spec, opts, args.step.positionals, capture.context);
        return maxExit(capture.exitCodes);
      },
      capture.exitCodes,
      (code) => {
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

  log.info?.({
    evt: 'cli.suite.run.step',
    suite: args.suite.name,
    suiteRunId: args.suiteRunId,
    tool: args.step.tool.metadata.id,
    command: args.step.spec.name,
    exitCode,
    durationMs,
  });

  return {
    tool: args.step.tool.metadata.name,
    stableId: args.step.tool.metadata.id,
    command: args.step.spec.name,
    exitCode,
    durationMs,
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
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
  exitCodes: readonly number[],
  onDirectExit?: (code: number) => void,
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
      onDirectExit?.(error.code);
      return error.code;
    }
    throw error;
  } finally {
    (process as unknown as { exit: typeof process.exit }).exit = original;
  }
}

function maxExit(codes: readonly number[]): number {
  return Math.max(EXIT_CODES.SUCCESS, ...codes);
}
