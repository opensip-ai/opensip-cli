/**
 * fit-runner — live-view entry for `opensip fit` via @opensip-cli/cli-live.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLiveView } from '@opensip-cli/cli-live';
import { type FitOptions, type RunPresentation } from '@opensip-cli/contracts';
import {
  runOffThreadOrInProcess,
  currentScope,
  liveEngineCorrelation,
  type LiveViewContext,
  type ToolRunCompletion,
} from '@opensip-cli/core';

import { buildFitVerboseDetail, envelopeToFitRows, type FitTableRow } from './fit/envelope-view.js';
import { buildFitnessSessionPayload } from './fit/result-builders.js';
import { checkCountLabel, withCheckCountFromProgress } from './fit-runner-progress.js';
import { ensureChecksLoaded, executeFit, getEnabledCheckCount } from './fit.js';

import type { LiveRunTableRow, ProgressEvent, ProgressSurface } from '@opensip-cli/cli-ui';
import type { DataStore } from '@opensip-cli/datastore';

const FIT_TOOL_TITLE = 'Fitness Checks';
const FIT_TOOL_DESCRIPTION =
  'Scanning your codebase for quality, security, and architecture issues.';

const FIT_LOADING_SURFACE: ProgressSurface = { shape: 'pool', label: 'Loading checks...' };
const FIT_RUNNING_SURFACE: ProgressSurface = { shape: 'pool', label: 'Running checks...' };

function executeFitWithProgress(
  args: FitOptions,
  emit: (event: ProgressEvent) => void,
): ReturnType<typeof executeFit> {
  emit({ type: 'stage-start', stage: 'checks', label: 'Running checks...' });
  return executeFit(args, {
    onProgress: (completed, total) =>
      emit({ type: 'stage-progress', stage: 'checks', completed, total }),
  });
}

function fitRowsToLiveRunTable(rows: readonly FitTableRow[]): LiveRunTableRow[] {
  return rows.map((row) => ({
    unit: row.check,
    status: row.status,
    errors: row.errors,
    warnings: row.warnings,
    duration: row.duration,
    durationMs: row.durationMs,
    validated: row.validated,
    ignored: row.ignored,
    itemType: row.itemType,
  }));
}

export interface RenderFitLiveOptions {
  readonly setExitCode?: (code: number) => void;
}

export async function renderFitLive(
  args: FitOptions,
  contextOrDatastore?: DataStore | LiveViewContext,
  options?: RenderFitLiveOptions,
): Promise<ToolRunCompletion> {
  const liveContext =
    contextOrDatastore && (contextOrDatastore as LiveViewContext).runSession
      ? (contextOrDatastore as LiveViewContext)
      : undefined;

  const recipe =
    args.tags && args.tags.length > 0 ? `tags: ${args.tags.join(',')}` : (args.recipe ?? 'default');
  let availableCount = 0;

  return runToolLiveView(
    {
      tool: 'fit',
      meta: { title: FIT_TOOL_TITLE, description: FIT_TOOL_DESCRIPTION },
      surface: FIT_RUNNING_SURFACE,
      loadingSurface: FIT_LOADING_SURFACE,
      verbose: args.verbose === true,
      quiet: args.quiet === true,
      staticChrome: true,
      initialShowRunHeader: false,
      projectPath: args.cwd,
      walkedUp: currentScope()?.projectContext?.walkedUp,
      produce: async (emit, helpers) => {
        await ensureChecksLoaded(args.cwd);
        availableCount = getEnabledCheckCount();

        const specDir = mkdtempSync(join(tmpdir(), 'fit-worker-'));
        const specPath = join(specDir, 'spec.json');
        writeFileSync(specPath, JSON.stringify(args), 'utf8');
        const correlation = liveEngineCorrelation(currentScope()?.correlation);
        const run = runOffThreadOrInProcess<ProgressEvent, Awaited<ReturnType<typeof executeFit>>>({
          descriptor: {
            command: process.argv[1] ?? '',
            argv: ['fit-run-worker', specPath],
            ...(correlation ? { correlation } : {}),
          },
          inProcess: (workerEmit) => executeFitWithProgress(args, workerEmit),
        });

        const subscribe = withCheckCountFromProgress(run.onProgress, (checkCount) => {
          helpers.setShowRunHeader(true);
          helpers.setHeaderMetadata([
            { label: 'Recipe', value: recipe },
            {
              label: 'Checks',
              value: checkCountLabel({
                running: checkCount,
                available: availableCount,
                verbose: args.verbose === true,
              }),
            },
          ]);
        });

        helpers.setRunning(subscribe);

        let fitResult: Awaited<ReturnType<typeof executeFit>>;
        try {
          fitResult = await run.result;
        } finally {
          rmSync(specDir, { recursive: true, force: true });
        }

        if (fitResult.result.type === 'error') {
          const err = fitResult.result;
          return {
            kind: 'error',
            message: err.message,
            exitCode: err.exitCode,
            ...(err.suggestion === undefined ? {} : { suggestion: err.suggestion }),
          };
        }

        const { result } = fitResult as { result: RunPresentation };
        const envelope = result.envelope;
        const verboseDetail = buildFitVerboseDetail(envelope, { verbose: args.verbose === true });
        const findingsGroups =
          verboseDetail?.kind === 'findings' && verboseDetail.groups.length > 0
            ? verboseDetail.groups
            : undefined;

        return {
          kind: 'done',
          done: {
            summary: {
              passed: envelope.verdict.passed,
              errors: envelope.verdict.summary.errors,
              warnings: envelope.verdict.summary.warnings,
            },
            ...(findingsGroups === undefined ? {} : { verboseFindings: findingsGroups }),
            ...(args.verbose === true
              ? { table: fitRowsToLiveRunTable(envelopeToFitRows(envelope)) }
              : {}),
            warnings: fitResult.warnings ?? [],
          },
          envelope,
          session: {
            tool: 'fit',
            cwd: args.cwd,
            recipe: envelope.recipe,
            score: envelope.verdict.score,
            passed: envelope.verdict.passed,
            payload: buildFitnessSessionPayload(envelope),
          },
        };
      },
    },
    {
      setExitCode: options?.setExitCode,
      liveContext,
    },
  );
}
