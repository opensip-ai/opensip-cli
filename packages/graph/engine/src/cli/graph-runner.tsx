/**
 * graph-runner — live-view entry for `opensip graph` via @opensip-cli/cli-live.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLiveView } from '@opensip-cli/cli-live';
import {
  shouldRenderRunUnitTable,
  type ProgressEvent,
  type ProgressSurface,
} from '@opensip-cli/cli-ui';
import {
  runOffThreadOrInProcess,
  currentScope,
  liveEngineCorrelation,
  type LiveViewContext,
  type ToolRunCompletion,
  type ToolSessionContribution,
} from '@opensip-cli/core';

import { assertFinalizedAcrossBoundary } from './apply-suppressions.js';
import { buildGraphEnvelope } from './build-envelope.js';
import { envelopeToLiveRunTableRows } from './graph-envelope-view.js';
import { SHARDED_STAGE_LABELS, STAGE_LABELS, toProgressEvent } from './graph-progress.js';
import { resolutionBannerText } from './graph-report.js';
import {
  buildLiveGraphOutput,
  contributionFromSignals,
  evaluatedRuleSlugs,
  runShardedLiveBuild,
  type LiveGraphOutput,
} from './graph.js';
import { GRAPH_STAGES, runGraph } from './orchestrate.js';

import type { Shard } from './orchestrate/shard-model.js';
import type { GraphStage } from './orchestrate.js';
import type { GraphConfig, ResolutionMode, Rule } from '../types.js';
import type { DataStore } from '@opensip-cli/datastore';

const GRAPH_TOOL_TITLE = 'Code Graph';
const GRAPH_TOOL_DESCRIPTION = 'Building call-graph from source';

const STAGE_RUNNING_DETAIL: Readonly<Record<GraphStage, string>> = {
  discover: 'Scanning source tree...',
  parse: 'Building program AST...',
  walk: 'Walking files for occurrences...',
  resolve: 'Binding symbols to edges...',
  index: 'Computing reverse indexes...',
  features: 'Computing feature columns...',
  rules: 'Evaluating rule set...',
};

const SHARDED_STAGE_RUNNING_DETAIL: Readonly<Record<GraphStage, string>> = {
  ...STAGE_RUNNING_DETAIL,
  parse: 'Building shards in parallel...',
  walk: 'Merging shard fragments...',
  resolve: 'Linking cross-package calls...',
};

function graphSurface(sharded: boolean): ProgressSurface {
  const labels = sharded ? SHARDED_STAGE_LABELS : STAGE_LABELS;
  const runningDetail = sharded ? SHARDED_STAGE_RUNNING_DETAIL : STAGE_RUNNING_DETAIL;
  return {
    shape: 'phases',
    stages: GRAPH_STAGES.map((id) => ({
      id,
      label: labels[id],
      runningDetail: runningDetail[id],
    })),
  };
}

export interface GraphRunnerArgs {
  readonly cwd: string;
  readonly noCache?: boolean;
  readonly resolution?: ResolutionMode;
  readonly verbose?: boolean;
  readonly quiet?: boolean;
  readonly config?: GraphConfig;
  readonly rules?: readonly Rule[];
  readonly recipe?: string;
  readonly exact?: boolean;
  readonly shards?: readonly Shard[];
}

async function runGraphWithProgress(
  args: GraphRunnerArgs,
  datastore: DataStore | undefined,
  emit: (event: ProgressEvent) => void,
): Promise<LiveGraphOutput> {
  const result = await runGraph({
    cwd: args.cwd,
    noCache: args.noCache,
    resolution: args.resolution,
    config: args.config,
    rules: args.rules,
    datastore,
    onProgress: (event) => emit(toProgressEvent(event)),
  });
  return buildLiveGraphOutput(result, args.cwd);
}

export interface RenderGraphLiveOptions {
  readonly setExitCode?: (code: number) => void;
}

export async function renderGraphLive(
  args: GraphRunnerArgs,
  datastore?: DataStore,
  options?: RenderGraphLiveOptions,
  liveContext?: LiveViewContext,
): Promise<ToolRunCompletion> {
  const sharded = (args.shards?.length ?? 0) > 1;

  return runToolLiveView(
    {
      tool: 'graph',
      meta: { title: GRAPH_TOOL_TITLE, description: GRAPH_TOOL_DESCRIPTION },
      surface: graphSurface(sharded),
      verbose: args.verbose === true,
      quiet: args.quiet === true,
      progressOnDone: true,
      loadingMessage: 'Initializing pipeline...',
      projectPath: args.cwd,
      walkedUp: currentScope()?.projectContext?.walkedUp,
      produce: async (_emit, helpers) => {
        const specDir = mkdtempSync(join(tmpdir(), 'graph-worker-'));
        const specPath = join(specDir, 'spec.json');
        writeFileSync(
          specPath,
          JSON.stringify({
            cwd: args.cwd,
            noCache: args.noCache,
            resolution: args.resolution,
            exact: args.exact,
            ...(sharded ? { shards: args.shards ?? [] } : {}),
            ...(args.recipe === undefined ? {} : { recipe: args.recipe }),
          }),
          'utf8',
        );
        const correlation = liveEngineCorrelation(currentScope()?.correlation);
        const run = runOffThreadOrInProcess<ProgressEvent, LiveGraphOutput>({
          preferWorker: true,
          descriptor: {
            command: process.argv[1] ?? '',
            argv: ['graph-run-worker', specPath],
            ...(correlation ? { correlation } : {}),
          },
          inProcess: (workerEmit) =>
            sharded
              ? runShardedLiveBuild(
                  {
                    cwd: args.cwd,
                    noCache: args.noCache,
                    resolution: args.resolution,
                    exact: args.exact,
                    config: args.config,
                    rules: args.rules,
                    cliScript: process.argv[1],
                  },
                  args.shards ?? [],
                  datastore,
                  (event) => workerEmit(toProgressEvent(event, true)),
                )
              : runGraphWithProgress(args, datastore, workerEmit),
        });

        helpers.setRunning(run.onProgress);

        try {
          let result: LiveGraphOutput;
          try {
            result = await run.result;
          } finally {
            rmSync(specDir, { recursive: true, force: true });
          }

          const finalized = assertFinalizedAcrossBoundary(result.signals, result.suppressedCount);
          const session: ToolSessionContribution = contributionFromSignals(
            { cwd: args.cwd, recipe: args.recipe },
            finalized.signals,
            evaluatedRuleSlugs(args.rules),
          );

          const envelope = buildGraphEnvelope({
            signals: finalized.signals,
            runId: currentScope()?.runId ?? '',
            createdAt: new Date().toISOString(),
          });
          const { verdict } = envelope;
          const banner = resolutionBannerText(result.resolutionMode);
          const table = shouldRenderRunUnitTable({ verbose: args.verbose === true })
            ? envelopeToLiveRunTableRows(envelope)
            : undefined;

          return {
            kind: 'done',
            done: {
              summary: {
                passed: verdict.passed,
                errors: verdict.summary.errors,
                warnings: verdict.summary.warnings,
              },
              ...(args.verbose === true ? { verboseLines: result.reportLines } : {}),
              ...(banner === undefined ? {} : { banner }),
              ...(table === undefined ? {} : { table }),
            },
            session,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { kind: 'error', message, exitCode: 1 };
        }
      },
    },
    {
      setExitCode: options?.setExitCode,
      liveContext,
    },
  );
}
