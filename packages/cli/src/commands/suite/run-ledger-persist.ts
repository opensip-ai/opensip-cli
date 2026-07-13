import {
  currentLogger,
  currentScope,
  generatePrefixedId,
  readPackageVersion,
} from '@opensip-cli/core';
import { RunRepo } from '@opensip-cli/session-store';

import { projectEnvelopeEvidence } from '../run-ledger-projection.js';

import type { SuiteSource } from './built-in-suites.js';
import type { SuiteStepReviewInput } from './review-brief.js';
import type { StoredRun, StoredRunStep, SuiteRunResult } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

const CLI_VERSION = readPackageVersion(import.meta.url);

export interface PersistSuiteRunInput {
  readonly result: SuiteRunResult;
  readonly internalSteps: readonly SuiteStepReviewInput[];
  readonly source: SuiteSource;
  readonly cwd: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export function persistSuiteRun(input: PersistSuiteRunInput): string | undefined {
  const scope = currentScope();
  const log = currentLogger();
  let datastore: DataStore | undefined;
  try {
    datastore = scope?.datastore() as DataStore | undefined;
  } catch (error) {
    log.debug?.({
      evt: 'cli.run-ledger.datastore_unavailable',
      module: 'cli:suite-run-ledger',
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (datastore === undefined) return;

  try {
    const runId = generatePrefixedId('run');
    const run: StoredRun = {
      id: runId,
      name: input.result.suite,
      source: input.source === 'built-in' ? 'built-in-suite' : 'configured-suite',
      ...(scope?.runId === undefined ? {} : { correlationRunId: scope.runId }),
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
      legacySuiteRunId: input.result.suiteRunId,
      cliVersion: CLI_VERSION,
    };
    const steps = input.internalSteps.map((step): StoredRunStep => {
      const summary = step.summary;
      return {
        id: generatePrefixedId('step'),
        runId,
        logicalStepKey: `${step.stepIndex}:${summary.stableId}:${summary.command}`,
        ordinal: step.stepIndex,
        attempt: 1,
        tool: summary.tool,
        command: summary.command,
        stableId: summary.stableId,
        ...(step.effectiveArgs === undefined ? {} : { effectiveArgs: step.effectiveArgs }),
        exitCode: summary.exitCode,
        outcome: summary.outcome,
        durationMs: summary.durationMs,
        ...(summary.verdict === undefined ? {} : { verdictSummary: summary.verdict }),
        ...(step.sessionId === undefined ? {} : { sessionId: step.sessionId }),
        ...(() => {
          const evidence = projectEnvelopeEvidence(step.capturedEnvelope);
          return evidence === undefined ? {} : { evidence };
        })(),
      };
    });
    new RunRepo(datastore).saveRunWithSteps(run, steps);
    log.info?.({
      evt: 'cli.run-ledger.suite_recorded',
      module: 'cli:suite-run-ledger',
      runId,
      suiteRunId: input.result.suiteRunId,
      stepCount: steps.length,
    });
    return runId;
  } catch (error) {
    log.warn?.({
      evt: 'cli.run-ledger.suite_record_failed',
      module: 'cli:suite-run-ledger',
      suiteRunId: input.result.suiteRunId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
