import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  currentLogger,
  currentScope,
  runEmbeddedRender,
  ToolError,
  type ToolCliContext,
  type ToolRunCompletion,
} from '@opensip-cli/core';

import { truncateDerivedMessage } from '../../bootstrap/report-failure.js';
import { hostErrorCatalog } from '../../errors/host-error-catalog.js';
import { runCommandSpecAction } from '../run-command-spec-action.js';

import { withProcessExitGuard } from './suite-step-helpers.js';

import type { createCapturingContext } from './capturing-context.js';
import type { ValidatedSuite, ValidatedSuiteStep } from './validate-suite.js';
import type { RunActionHooks } from '../../bootstrap/run-plane.js';

const CAPABILITY_MISMATCH = hostErrorCatalog.require('CLI.SUITE.CAPABILITY_MISMATCH');
const EVIDENCE_MISSING = hostErrorCatalog.require('CLI.SUITE.EVIDENCE_MISSING');

export interface RunStepInput {
  readonly suite: ValidatedSuite;
  readonly suiteRunId: string;
  readonly step: ValidatedSuiteStep;
  readonly ctx: ToolCliContext;
  readonly runActionHooks: RunActionHooks;
  readonly suiteOpts: Readonly<Record<string, unknown>>;
  readonly defaultChanged?: boolean;
  readonly fullScopeFiles?: readonly string[];
}

export interface SuiteCompletionObservation {
  returnedEvidence: boolean;
  returnedEnvelope: boolean;
  returnedSession: boolean;
}

const SAFE_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function loggedStepFailureCode(error: unknown): string {
  return error instanceof ToolError && SAFE_ERROR_CODE.test(error.code)
    ? error.code
    : 'RUN.STEP.EXECUTION_FAILED';
}

/** Execute one suite step headlessly while capturing every exit source. */
export async function executeStep(input: {
  readonly args: RunStepInput;
  readonly opts: Readonly<Record<string, unknown>>;
  readonly capture: ReturnType<typeof createCapturingContext>;
  readonly hooks: RunActionHooks;
}): Promise<{
  readonly exitCode: number;
  readonly errorMessage?: string;
  readonly errorCode?: string;
}> {
  const { args, opts, capture, hooks } = input;
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
        // Embedded rendering keeps the parent suite as the sole visible result.
        await runEmbeddedRender(() =>
          runCommandSpecAction(args.step.spec, opts, args.step.positionals, capture.context, hooks),
        );
        return capture.getExitCode() ?? EXIT_CODES.SUCCESS;
      },
      (code) => {
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
    errorCode = loggedStepFailureCode(error);
    diagnostics?.event('execute', 'error', `suite step '${args.step.spec.name}' failed`, {
      suite: args.suite.name,
      suiteRunId: args.suiteRunId,
      tool: args.step.tool.metadata.id,
      command: args.step.spec.name,
      exitCode,
      reason: errorCode,
    });
    log.error?.({
      evt: 'cli.suite.run.step.error',
      suite: args.suite.name,
      suiteRunId: args.suiteRunId,
      tool: args.step.tool.metadata.id,
      command: args.step.spec.name,
      reason: errorCode,
    });
  }
  return {
    exitCode,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

/** Enforce the command's declared verdict/evidence capability after execution. */
export function assertStepCompletion(input: {
  readonly executed: Awaited<ReturnType<typeof executeStep>>;
  readonly producesVerdict: boolean;
  readonly hasSession: boolean;
  readonly hasEnvelope: boolean;
  readonly evidenceStep: boolean;
  readonly evidenceCount: number;
  readonly capabilityMismatch: boolean;
}): {
  readonly exitCode: number;
  readonly errorMessage?: string;
  readonly errorCode?: string;
} {
  let { errorMessage, errorCode, exitCode } = input.executed;
  if (errorMessage === undefined && input.capabilityMismatch) {
    exitCode = Math.max(exitCode, EXIT_CODES.RUNTIME_ERROR);
    errorMessage = 'Suite step returned output outside its declared evidence/verdict capability.';
    errorCode = CAPABILITY_MISMATCH.code;
  }
  if (
    errorMessage === undefined &&
    input.producesVerdict &&
    !input.hasSession &&
    !input.hasEnvelope
  ) {
    exitCode = Math.max(exitCode, EXIT_CODES.RUNTIME_ERROR);
    errorMessage = 'Verdict-producing suite step completed without session or captured evidence.';
    errorCode = EVIDENCE_MISSING.code;
  }
  if (errorMessage === undefined && input.evidenceStep && input.evidenceCount === 0) {
    exitCode = Math.max(exitCode, EXIT_CODES.RUNTIME_ERROR);
    errorMessage = 'Evidence-producing suite step completed without a captured contribution.';
    errorCode = EVIDENCE_MISSING.code;
  }
  return {
    exitCode,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function completionRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Narrow the privileged run hook to the capability declared by the suite step. */
export function capabilityBoundCompleteRun(
  step: ValidatedSuiteStep,
  base: RunActionHooks['completeRun'],
  observation: SuiteCompletionObservation,
): NonNullable<RunActionHooks['completeRun']> {
  return (value) => {
    const record = completionRecord(value);
    observation.returnedEvidence = record?.evidenceSnapshots !== undefined;
    observation.returnedEnvelope = record?.envelope !== undefined;
    observation.returnedSession = record?.session !== undefined;
    if (base === undefined || record === undefined) {
      base?.(value);
      return;
    }
    if (step.kind === 'evidence') {
      base(
        record.evidenceSnapshots === undefined
          ? ({} satisfies ToolRunCompletion)
          : { evidenceSnapshots: record.evidenceSnapshots },
      );
      return;
    }
    if (record.evidenceSnapshots !== undefined) {
      base({} satisfies ToolRunCompletion);
      return;
    }
    base(value);
  };
}
