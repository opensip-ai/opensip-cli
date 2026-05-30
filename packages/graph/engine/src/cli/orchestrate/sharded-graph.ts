/**
 * Sharded build pipeline (plan #2, Phase 4).
 *
 * Ties the shard substrate together into a single unified build:
 *   plan (reuse cached fragments) → run changed shards in parallel →
 *   merge fragments + recover cross-package edges → persist → derive
 *   indexes + run rules → return the same RunGraphResult the
 *   single-process path produces.
 *
 * The result's catalog is unified: intra-shard edges keep their original
 * (semantic, in exact mode) fidelity; cross-package edges are recovered
 * by the boundary pass and labeled `crossShard: true` / `'syntactic'`.
 */

import { logger, type Signal } from '@opensip-tools/core';

import { buildIndexes } from '../../pipeline/indexes.js';
import { currentRules } from '../../rules/registry.js';

import { mergeAndResolveShards } from './cross-shard-resolve.js';
import { planShardWork, runShardsInParallel } from './shard-runner.js';

import type { Shard } from './shard-model.js';
import type { GraphLanguageAdapter } from '../../lang-adapter/types.js';
import type { CatalogRepo } from '../../persistence/catalog-repo.js';
import type { Catalog, GraphConfig, Indexes, ResolutionMode, ResolutionStats, Rule } from '../../types.js';

/**
 * Input to {@link runShardedGraph}: the planned shards plus the shared build
 * context (project root, worker entry script, language adapter, resolution
 * tier, cache/persistence handles, and optional rules/config overrides).
 */
export interface RunShardedInput {
  readonly shards: readonly Shard[];
  /** Common project root — every fragment's filePaths resolve against it. */
  readonly projectRoot: string;
  /** CLI entry script (`process.argv[1]`) for spawning shard workers. */
  readonly cliScript: string;
  readonly adapter: GraphLanguageAdapter;
  readonly resolutionMode: ResolutionMode;
  readonly concurrency?: number;
  readonly useCache: boolean;
  readonly catalogRepo: CatalogRepo | null;
  readonly config?: GraphConfig;
  readonly rules?: readonly Rule[];
}

/**
 * Result of {@link runShardedGraph}: the unified catalog and derived indexes,
 * the rule signals evaluated over it, cross-shard resolution stats, and
 * cache/failure metadata (whether every shard was a cache hit, and the ids of
 * any shards whose worker failed).
 */
export interface RunShardedResult {
  readonly catalog: Catalog;
  readonly indexes: Indexes;
  readonly signals: readonly Signal[];
  readonly resolutionStats: ResolutionStats;
  /** True when every shard was reused from cache (no worker ran). */
  readonly cacheHit: boolean;
  /** Shard ids whose worker failed (build proceeds with the rest). */
  readonly failedShardIds: readonly string[];
}

/** Run the full sharded build and return a unified RunGraphResult-shaped value. */
export async function runShardedGraph(input: RunShardedInput): Promise<RunShardedResult> {
  const { shards, projectRoot, cliScript, adapter, resolutionMode, useCache, catalogRepo } = input;

  // 1. Decide which shards can be reused from cache vs must be rebuilt.
  const plan = planShardWork(shards, catalogRepo, adapter, resolutionMode, useCache);

  // 2. Build the changed shards in parallel worker processes.
  const built = await runShardsInParallel({
    shards: plan.toBuild,
    projectRoot,
    cliScript,
    resolutionMode,
    concurrency: input.concurrency,
  });
  for (const failure of built.failures) {
    logger.error({
      evt: 'graph.sharded.shard_failed',
      module: 'graph:sharded',
      shardId: failure.shardId,
      exitCode: failure.exitCode,
      stderr: failure.stderr.slice(0, 500),
    });
  }

  // 3. Merge cached + freshly-built fragments and recover cross-package edges.
  const fragments = [...plan.cached, ...built.fragments];
  const allFiles = shards.flatMap((s) => s.files);
  const { catalog, boundaryStats } = mergeAndResolveShards(fragments, allFiles);

  // 4. Persist: each rebuilt shard's fragment, prune removed shards, and the
  //    unified full catalog (so whole-catalog consumers still work).
  if (useCache && catalogRepo) {
    // @fitness-ignore-next-line detached-promises -- CatalogRepo is synchronous (better-sqlite3/Drizzle); upsertShardFragment returns void, not a Promise.
    for (const fragment of built.fragments) catalogRepo.upsertShardFragment(fragment);
    // @fitness-ignore-next-line detached-promises -- CatalogRepo is synchronous (better-sqlite3/Drizzle); pruneShardFragmentsExcept returns void, not a Promise.
    catalogRepo.pruneShardFragmentsExcept(shards.map((s) => s.id));
    try {
      catalogRepo.replaceAll(catalog);
    } catch (error) {
      /* v8 ignore next */
      // Best-effort write: the freshly-built catalog is returned regardless.
      // replaceAll already logged the underlying error; note the continuation
      // so the swallow isn't silent.
      logger.debug({
        evt: 'graph.sharded.cache_write_skipped',
        module: 'graph:sharded',
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 5. Derive indexes + run rules over the unified catalog.
  const indexes = buildIndexes(catalog);
  const ruleSet = input.rules ?? currentRules();
  const config: GraphConfig = input.config ?? {};
  const signals: Signal[] = [];
  for (const rule of ruleSet) {
    // Indexed append rather than spread-in-loop — avoids re-allocating the
    // accumulator on every rule (O(n²)) over a potentially large rule set.
    const ruleSignals = rule.evaluate(catalog, indexes, config, adapter.ruleHints);
    for (const signal of ruleSignals) signals.push(signal);
  }

  return {
    catalog,
    indexes,
    signals,
    resolutionStats: boundaryStats,
    cacheHit: plan.toBuild.length === 0,
    failedShardIds: built.failures.map((f) => f.shardId),
  };
}
