import {
  ConfigurationError,
  currentScope,
  logger,
  SystemError,
  type ToolCliContext,
} from '@opensip-cli/core';

import { DASHBOARD_FEATURE_COLUMNS } from './graph-feature-columns.js';
import { countFiles } from './graph-report.js';
import {
  engineSelectionReason,
  realpathOrSelf,
  resolveEngineShards,
  runProfiledShardedBuild,
} from './graph-sharded-engine.js';
import { loadGraphConfig, runGraph, type RunGraphResult } from './orchestrate.js';
import { positionalPathLabel } from './positional-paths.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { GraphRunOutcome } from './graph-run-outcome.js';
import type { GraphProfileBuilder, GraphProfileRunRecorder } from './profile.js';
import type { Catalog, Rule } from '../types.js';
import type { DataStore } from '@opensip-cli/datastore';

const MODULE_GRAPH_CLI = 'graph:cli';

type DispatchGraphResult = (
  opts: GraphCommandOptions,
  rawResult: RunGraphResult,
  cli: ToolCliContext,
  startedAt: string,
  suppressionRoot: string,
) => Promise<GraphRunOutcome | undefined>;

export interface SinglePathContext {
  readonly opts: GraphCommandOptions;
  readonly cli: ToolCliContext;
  readonly rules: readonly Rule[];
  readonly startedAt: string;
  readonly profile?: GraphProfileBuilder;
  readonly dispatchGraphResult: DispatchGraphResult;
}

function recordPartitionStage(
  profileRun: GraphProfileRunRecorder | undefined,
  partition: { readonly durationMs: number; readonly detail: string } | undefined,
): void {
  if (profileRun === undefined || partition === undefined) return;
  profileRun.recordStage('partition', partition.durationMs, partition.detail);
}

function finishProfileRun(
  profileRun: GraphProfileRunRecorder | undefined,
  result: RunGraphResult,
): void {
  if (profileRun !== undefined) {
    profileRun.finish(result);
  }
}

/**
 * Whole-project or single-positional-path graph execution. Owns the
 * exact/sharded engine dispatch, profiling run bucket, shard-failure surfacing,
 * and language mismatch policy for the single-run shape.
 */
export async function executeSinglePathGraph(
  ctx: SinglePathContext,
  positionalPaths: readonly string[],
): Promise<GraphRunOutcome | undefined> {
  const { opts, cli, rules, startedAt, profile, dispatchGraphResult } = ctx;
  // Realpath the run root ONCE, before engine selection (F3 path parity). The
  // EXACT engine normalizes its project dir via realpathSync internally
  // (graph-typescript normalize-project-dir); the SHARDED worker derives
  // project-relative `code.file` paths against this `projectRoot`. Under a
  // symlinked cwd a RAW root would make the sharded paths gain `../..` prefixes
  // while exact stays canonical, so the two engines emitted different
  // `code.file` values. Canonicalizing here keeps both engines byte-identical.
  const runCwd = realpathOrSelf(positionalPaths[0] ?? opts.cwd, opts.cwd);
  const config = loadGraphConfig(opts.cwd);

  const resolution = await resolveEngineShards(opts, cli, positionalPaths);
  const shards = resolution.shards;
  logger.info({
    evt: 'graph.cli.graph.engine',
    module: MODULE_GRAPH_CLI,
    mode: shards.length > 1 ? 'sharded' : 'exact',
    requestedExact: opts.exact === true,
    shards: shards.length,
    reason: engineSelectionReason(opts, positionalPaths, shards.length > 1),
  });

  const profileRun = profile?.startRun({
    label: positionalPaths.length === 0 ? 'root' : positionalPathLabel(runCwd, opts.cwd),
    cwd: runCwd,
    mode: shards.length > 1 ? 'sharded' : 'single-process',
  });
  recordPartitionStage(profileRun, resolution.partition);

  const result =
    shards.length > 1
      ? await runProfiledShardedBuild(profileRun, {
          opts,
          shards,
          projectRoot: runCwd,
          cli,
          config,
          rules,
        })
      : await runGraph({
          cwd: runCwd,
          noCache: opts.noCache,
          resolution: opts.resolution,
          language: opts.language,
          config,
          rules,
          datastore: cli.scope.datastore() as DataStore | undefined,
          emitFeatures: DASHBOARD_FEATURE_COLUMNS,
          onProgress: profileRun?.onProgress,
        });
  finishProfileRun(profileRun, result);

  if (shards.length > 1) {
    const sharded = result as { failedShardIds?: readonly string[] };
    if (sharded.failedShardIds && sharded.failedShardIds.length > 0) {
      throw new SystemError(
        `Sharded graph build had ${sharded.failedShardIds.length} shard failure(s); ` +
          `catalog and any --gate-* / baseline artifacts are incomplete. ` +
          `See 'graph.sharded.shard_failed' log events for per-shard details.`,
        { code: 'GRAPH.SHARD.FAILURES' },
      );
    }
  }

  enforceLanguageMismatchPolicy(opts, result.catalog, [runCwd]);
  const scope = currentScope();
  if (scope !== undefined) {
    scope.diagnostics.event('execute', 'debug', 'graph build complete', {
      mode: shards.length > 1 ? 'sharded' : 'exact',
      shards: shards.length,
    });
  }
  return await dispatchGraphResult(opts, result, cli, startedAt, runCwd);
}

/**
 * D14 mixed policy. When `--language X` was specified and the run discovered
 * zero files matching that adapter, exit 2 with the canonical error. Automatic
 * detection paths do not trigger this check.
 */
function enforceLanguageMismatchPolicy(
  opts: GraphCommandOptions,
  catalog: Catalog | null,
  paths: readonly string[],
): void {
  if (typeof opts.language !== 'string' || opts.language.length === 0) return;
  const fileCount = catalog === null ? 0 : countFiles(catalog);
  if (fileCount > 0) return;
  const pathLabel = paths.map((p) => positionalPathLabel(p, opts.cwd)).join(', ');
  throw new ConfigurationError(
    `--language ${opts.language} matched 0 files under ${pathLabel}; check the flag or paths.`,
  );
}
