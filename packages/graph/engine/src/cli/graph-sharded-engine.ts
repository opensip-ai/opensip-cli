import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { shardGraphDegradations } from '../degradation.js';
import { pickAdapter } from '../lang-adapter/registry.js';
import { CatalogRepo } from '../persistence/catalog-repo.js';
import { currentRules } from '../rules/registry.js';

import { DASHBOARD_FEATURE_COLUMNS } from './graph-feature-columns.js';
import { buildLiveGraphOutput, type LiveGraphOutput } from './graph-report.js';
import {
  resolveDefaultEngineShards,
  type EngineShardPolicyResolution,
} from './orchestrate/engine-shard-policy.js';
import { loadGraphConfig, runShardedGraph } from './orchestrate.js';
import { resolveAdaptersForRun } from './resolve-adapters.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { Shard } from './orchestrate/shard-model.js';
import type { GraphProgressCallback, RunGraphResult } from './orchestrate.js';
import type { GraphProfileRunRecorder } from './profile.js';
import type { GraphConfig, ResolutionMode, Rule } from '../types.js';
import type { ToolCliContext } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

/**
 * Resolve a path to absolute (a relative input resolves against `base`, not
 * necessarily `process.cwd()`), then realpath it so exact and sharded engines see
 * one canonical run root. Falls back to the absolute path when realpath fails.
 */
export function realpathOrSelf(input: string, base: string): string {
  const absolute = resolve(base, input);
  try {
    return realpathSync(absolute);
  } catch {
    /* v8 ignore next */
    return absolute;
  }
}

/** Shard resolution plus optional synthetic-partition timing. */
export type ShardResolution = EngineShardPolicyResolution;

/**
 * Engine-selection policy (ADR-0033, superseding ADR-0032/0031). The sharded
 * engine is the default when the project can actually shard; exact is selected
 * for `--exact`, positional runs, or non-shardable projects.
 */
export async function resolveEngineShards(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
  positionalPaths: readonly string[],
): Promise<ShardResolution> {
  if (opts.exact === true) return { shards: [] };
  if (positionalPaths.length > 0) return { shards: [] };
  return resolveShards(opts, cli);
}

/** Human-readable explanation for the graph engine observability event. */
export function engineSelectionReason(
  opts: GraphCommandOptions,
  positionalPaths: readonly string[],
  sharded: boolean,
): string {
  if (sharded) return 'sharded-default';
  if (opts.exact === true) return 'exact-opt-out';
  if (positionalPaths.length > 0) return 'exact-positional-paths';
  return 'exact-not-shardable';
}

async function resolveShards(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): Promise<ShardResolution> {
  const cliScript = opts.cliScript ?? process.argv[1];
  if (typeof cliScript !== 'string' || cliScript.length === 0) return { shards: [] };
  let languageAdapters: ReturnType<typeof resolveAdaptersForRun> = [];
  try {
    languageAdapters = resolveAdaptersForRun(opts, cli);
  } catch {
    // Preserve the producer policy: a forced graph adapter can still run exact
    // when the independent core language registry has no matching entry.
    if (typeof opts.language === 'string' && opts.language.length > 0) return { shards: [] };
  }
  return resolveDefaultEngineShards({
    projectRoot: opts.cwd,
    languageAdapters,
    graphAdapter: pickAdapter(opts.cwd),
    graphConfig: loadGraphConfig(opts.cwd),
    forcedLanguage: typeof opts.language === 'string' && opts.language.length > 0,
  });
}

/**
 * Resolve a project's shard set the same way a production `graph` run does,
 * exposed for the real-repo equivalence guardrail.
 */
export async function resolveShardsForCwd(
  cwd: string,
  cliScript: string,
  cli: ToolCliContext,
): Promise<readonly Shard[]> {
  const resolution = await resolveShards({ cwd, cliScript, noCache: true }, cli);
  return resolution.shards;
}

/** Inputs the sharded build path threads from `executeGraph`. */
export interface ShardedBuildContext {
  readonly opts: GraphCommandOptions;
  readonly shards: readonly Shard[];
  readonly projectRoot: string;
  readonly cli: ToolCliContext;
  readonly config: GraphConfig;
  readonly rules: readonly Rule[];
  readonly onProgress?: GraphProgressCallback;
}

async function runShardedBuild(ctx: ShardedBuildContext): Promise<RunGraphResult> {
  const { opts, shards, projectRoot, cli, config, rules } = ctx;
  const datastore = cli.scope.datastore() as DataStore | undefined;
  const sharded = await runShardedGraph({
    shards,
    projectRoot,
    cliScript: opts.cliScript ?? process.argv[1] ?? '',
    adapter: pickAdapter(projectRoot, opts.language),
    resolutionMode: opts.resolution ?? 'exact',
    concurrency: opts.concurrency,
    useCache: opts.noCache !== true,
    config,
    rules,
    catalogRepo: datastore ? new CatalogRepo(datastore) : null,
    emitFeatures: DASHBOARD_FEATURE_COLUMNS,
    ...(ctx.onProgress === undefined ? {} : { onProgress: ctx.onProgress }),
    ...(opts.language === undefined ? {} : { language: opts.language }),
  });
  return {
    catalog: sharded.catalog,
    indexes: sharded.indexes,
    signals: sharded.signals,
    resolutionStats: sharded.resolutionStats,
    cacheHit: sharded.cacheHit,
    features: sharded.features,
    shardStats: sharded.shardStats,
    degradations: shardGraphDegradations(sharded.failedShardIds),
  };
}

/**
 * Run a sharded build and record its wall-clock stage in the optional graph
 * profile. The build result is unchanged; this helper only centralizes timing
 * so the main command handler does not own sharded profiling mechanics.
 */
export async function runProfiledShardedBuild(
  profileRun: GraphProfileRunRecorder | undefined,
  ctx: ShardedBuildContext,
): Promise<RunGraphResult> {
  const started = Date.now();
  const result = await runShardedBuild(ctx);
  if (profileRun !== undefined) {
    profileRun.recordStage(
      'sharded-build',
      Date.now() - started,
      `${String(ctx.shards.length)} shard(s)`,
    );
  }
  return result;
}

/**
 * Serializable live-build request handed from the interactive runner to the
 * graph engine. Mirrors the subset of GraphCommandOptions the live view needs.
 */
export interface GraphLiveBuildArgs {
  readonly cwd: string;
  readonly noCache?: boolean;
  readonly resolution?: ResolutionMode;
  readonly exact?: boolean;
  readonly config?: GraphConfig;
  readonly rules?: readonly Rule[];
  readonly cliScript?: string;
}

/**
 * Resolve the live runner's build engine with the same shardability policy the
 * static `graph` command uses. The live UI consumes the returned shard list to
 * choose exact vs. sharded worker execution.
 */
export async function resolveLiveEngineShards(
  args: GraphLiveBuildArgs,
  cli: ToolCliContext,
): Promise<Shard[]> {
  const opts: GraphCommandOptions = {
    cwd: args.cwd,
    noCache: args.noCache,
    resolution: args.resolution,
    exact: args.exact,
    ...(args.cliScript === undefined ? {} : { cliScript: args.cliScript }),
  };
  const resolution = await resolveEngineShards(opts, cli, []);
  return resolution.shards;
}

/**
 * Execute a sharded graph build for the interactive/live runner and reduce the
 * result to the serializable `LiveGraphOutput` shape consumed by Ink and worker
 * transports.
 */
export async function runShardedLiveBuild(
  args: GraphLiveBuildArgs,
  shards: readonly Shard[],
  datastore: DataStore | undefined,
  onProgress: GraphProgressCallback,
): Promise<LiveGraphOutput> {
  const result = await runShardedGraph({
    shards,
    projectRoot: args.cwd,
    cliScript: args.cliScript ?? process.argv[1] ?? '',
    adapter: pickAdapter(args.cwd),
    resolutionMode: args.resolution ?? 'exact',
    useCache: args.noCache !== true,
    config: args.config ?? {},
    rules: args.rules ?? currentRules(),
    catalogRepo: datastore ? new CatalogRepo(datastore) : null,
    emitFeatures: DASHBOARD_FEATURE_COLUMNS,
    onProgress,
  });
  return buildLiveGraphOutput(
    {
      catalog: result.catalog,
      indexes: result.indexes,
      signals: result.signals,
      cacheHit: result.cacheHit,
      degradations: shardGraphDegradations(result.failedShardIds),
    },
    args.cwd,
  );
}
