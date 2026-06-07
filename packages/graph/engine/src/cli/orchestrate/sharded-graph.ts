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

import { logger, ValidationError, withSpanAsync, type Signal, type Span } from '@opensip-tools/core';

import { assignPackages } from '../../pipeline/assign-packages.js';
import { constrainCrossPackageEdges } from '../../pipeline/constrain-edges.js';
import { unionFeatureDeps } from '../../pipeline/feature-deps.js';
import {
  buildFeatures,
  isPersistedFeaturesEmpty,
  toPersistedFeatures,
} from '../../pipeline/features.js';
import { buildIndexes } from '../../pipeline/indexes.js';
import { currentRules } from '../../rules/registry.js';
import { GRAPH_TRACER } from '../graph-tracer.js';

import { mergeAndResolveShards } from './cross-shard-resolve.js';
import { buildPackageManifestIndex } from './export-index.js';
import { planShardWork, runShardsInParallel } from './shard-runner.js';

import type { Shard } from './shard-model.js';
import type { GraphLanguageAdapter } from '../../lang-adapter/types.js';
import type { CatalogRepo } from '../../persistence/catalog-repo.js';
import type {
  Catalog,
  FeatureColumn,
  FeatureTable,
  GraphConfig,
  Indexes,
  ResolutionMode,
  ResolutionStats,
  Rule,
} from '../../types.js';

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
  /**
   * Dashboard feature columns to materialize into the persisted catalog
   * (ADR-0006). The sharded build is the producing run for multi-package
   * repos, so it persists the same columns as the single path. Unioned with
   * the rule set's `featureDeps`.
   */
  readonly emitFeatures?: readonly FeatureColumn[];
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
  /** Engine-computed feature table over the merged global catalog (only the
   *  requested columns populated). */
  readonly features: FeatureTable;
}

/** Run the full sharded build and return a unified RunGraphResult-shaped value. */
export async function runShardedGraph(input: RunShardedInput): Promise<RunShardedResult> {
  // One parent span for the whole sharded build. withSpanAsync keeps it open
  // across the awaited parallel work, so the per-shard worker spans — which
  // inherit our context via the TRACEPARENT the runner propagates — nest under
  // it instead of forming orphan traces. Hard no-op when no SDK is registered.
  return withSpanAsync(
    GRAPH_TRACER,
    'opensip_tools.graph.sharded_build',
    (span) => buildShardedGraph(input, span),
    { 'opensip_tools.graph.shard_count': input.shards.length },
  );
}

async function buildShardedGraph(input: RunShardedInput, span: Span): Promise<RunShardedResult> {
  const { shards, projectRoot, cliScript, adapter, resolutionMode, useCache, catalogRepo } = input;

  // 0. Fail loud on duplicate shard ids. The shard id is the per-shard
  //    fragment-cache PRIMARY KEY (`graph_shard_fragment.shard_id`); two shards
  //    sharing an id silently overwrite each other's cache row, so the warm
  //    build never reaches a stable all-cached state and the function/entry-
  //    point counts drift run-to-run. A duplicate id is a discovery bug (e.g. a
  //    workspace-unit id derived by bare basename collapsing nested packages),
  //    never a recoverable runtime condition — so we throw rather than return a
  //    quietly-wrong graph.
  assertUniqueShardIds(shards);

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
  // The export linker keys packages by name; build the manifest index once from
  // the resolved shard set (each shard.rootDir holds a package.json) so the
  // boundary resolver can turn a bare specifier into a target package group.
  const manifestIndex = buildPackageManifestIndex(shards, projectRoot);
  const { catalog: merged, boundaryStats } = mergeAndResolveShards(fragments, allFiles, manifestIndex);
  // Stamp each occurrence's package, then drop name-guessed cross-package edges
  // that contradict the import graph — the same correction applied to the
  // single-program path, so the persisted catalog (and the coupling grid) is
  // import-consistent in both build modes.
  const catalog = constrainCrossPackageEdges(assignPackages(merged, projectRoot));

  // 4. Derive indexes + features over the unified catalog. Features run once
  //    here on the merged global catalog (not per shard), after merge / before
  //    rules — the same stage order as the single-program path.
  const indexes = buildIndexes(catalog);
  const ruleSet = input.rules ?? currentRules();
  const config: GraphConfig = input.config ?? {};
  const requestedColumns = unionFeatureDeps(ruleSet, input.emitFeatures);
  const features = buildFeatures(catalog, indexes, config, requestedColumns);
  const persistedFeatures = toPersistedFeatures(features, requestedColumns);
  const persisted = isPersistedFeaturesEmpty(persistedFeatures) ? undefined : persistedFeatures;
  // The catalog persisted (and returned) carries the materialized dashboard
  // columns when requested; otherwise the bare catalog (lean default).
  const catalogToPersist: Catalog = persisted ? { ...catalog, features: persisted } : catalog;

  // 5. Persist: each rebuilt shard's fragment, prune removed shards, and the
  //    unified full catalog (with materialized features when requested) so
  //    whole-catalog consumers (incl. the dashboard) still work.
  if (useCache && catalogRepo) {
    // @fitness-ignore-next-line detached-promises -- CatalogRepo is synchronous (better-sqlite3/Drizzle); upsertShardFragment returns void, not a Promise.
    for (const fragment of built.fragments) catalogRepo.upsertShardFragment(fragment);
    // @fitness-ignore-next-line detached-promises -- CatalogRepo is synchronous (better-sqlite3/Drizzle); pruneShardFragmentsExcept returns void, not a Promise.
    catalogRepo.pruneShardFragmentsExcept(shards.map((s) => s.id));
    try {
      catalogRepo.replaceAll(catalogToPersist);
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

  // 6. Run rules over the unified catalog, threading the feature table (5th arg).
  const signals: Signal[] = [];
  for (const rule of ruleSet) {
    // Indexed append rather than spread-in-loop — avoids re-allocating the
    // accumulator on every rule (O(n²)) over a potentially large rule set.
    const ruleSignals = rule.evaluate(catalog, indexes, config, adapter.ruleHints, features);
    for (const signal of ruleSignals) signals.push(signal);
  }

  span.setAttributes({
    'opensip_tools.graph.shards_built': plan.toBuild.length,
    'opensip_tools.graph.shards_cached': plan.cached.length,
    'opensip_tools.graph.shards_failed': built.failures.length,
  });
  return {
    catalog: catalogToPersist,
    indexes,
    signals,
    resolutionStats: boundaryStats,
    cacheHit: plan.toBuild.length === 0,
    failedShardIds: built.failures.map((f) => f.shardId),
    features,
  };
}

/**
 * Throw if any two shards share an id. The shard id is the per-shard
 * fragment-cache primary key, so a collision corrupts the warm-build cache and
 * makes the graph non-deterministic — a class of bug that must fail loud, never
 * silently return a wrong graph. Lists the offending ids in the error.
 */
function assertUniqueShardIds(shards: readonly Shard[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const shard of shards) {
    if (seen.has(shard.id)) duplicates.add(shard.id);
    seen.add(shard.id);
  }
  if (duplicates.size > 0) {
    const ids = [...duplicates].sort().join(', ');
    throw new ValidationError(
      `Duplicate shard id(s) [${ids}] in the sharded build — shard ids must be ` +
        `unique (they are the per-shard fragment-cache primary key). This is a ` +
        `workspace-unit discovery bug (e.g. ids derived by bare basename ` +
        `collapsing nested packages); fix id derivation to be root-relative.`,
    );
  }
}
