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
    for (const fragment of built.fragments) catalogRepo.upsertShardFragment(fragment);
    catalogRepo.pruneShardFragmentsExcept(shards.map((s) => s.id));
    try {
      catalogRepo.replaceAll(catalog);
    } catch {
      /* v8 ignore next */ // Cache write failure is non-fatal — already logged.
    }
  }

  // 5. Derive indexes + run rules over the unified catalog.
  const indexes = buildIndexes(catalog);
  const ruleSet = input.rules ?? currentRules();
  const config: GraphConfig = input.config ?? {};
  const signals: Signal[] = [];
  for (const rule of ruleSet) {
    signals.push(...rule.evaluate(catalog, indexes, config, adapter.ruleHints));
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
