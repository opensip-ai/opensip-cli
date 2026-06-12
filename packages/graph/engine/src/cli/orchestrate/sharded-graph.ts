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

import {
  logger,
  ValidationError,
  withSpanAsync,
  type Signal,
  type Span,
} from '@opensip-tools/core';

import { buildPackageManifestIndex } from '../../cross-package/export-index.js';
import { unionFeatureDeps } from '../../pipeline/feature-deps.js';
import {
  buildFeatures,
  isPersistedFeaturesEmpty,
  toPersistedFeatures,
} from '../../pipeline/features.js';
import { buildIndexes } from '../../pipeline/indexes.js';
import { currentRules } from '../../rules/registry.js';
import { GRAPH_TRACER } from '../graph-tracer.js';

import { countCatalogCallSites, countCatalogFunctions } from './catalog-stats.js';
import {
  mergeShardFragments,
  resolveCrossBoundaryCalls,
  stampAndConstrainPackages,
} from './cross-shard-resolve.js';
import { planShardWork, runShardsInParallel } from './shard-runner.js';

import type { Shard, ShardBuildResult, ShardRunStats } from './shard-model.js';
import type { GraphProgressCallback, GraphStage } from './types.js';
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
  /** Optional adapter id requested by the parent `graph --language <id>` run. */
  readonly language?: string;
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
  /**
   * Optional structured progress callback (ADR-0032). The sharded build maps its
   * work onto the SAME seven canonical {@link GraphStage}s the single-program
   * (`runGraph`) path emits, so the live renderer (`graph-runner.tsx`) shows the
   * identical "Code Graph" checklist for the sharded default and `--exact`:
   *   - `discover` — total file count across all shards
   *   - `parse`    — the parallel shard phase (sub-label: shard count)
   *   - `walk`     — merge the per-shard fragments into the unified catalog
   *   - `resolve`  — recover cross-package edges across shard boundaries
   *   - `index`    — derive reverse indexes over the merged catalog
   *   - `features` — derive the feature columns
   *   - `rules`    — evaluate the rule set
   * Non-interactive callers (json/gate/report) leave it undefined — a no-op.
   */
  readonly onProgress?: GraphProgressCallback;
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
  /** Per-run sharded-build statistics (mirrored into the --profile summary). */
  readonly shardStats: ShardRunStats;
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
  const onProgress = input.onProgress;

  // 0. Fail loud on duplicate shard ids. The shard id is the per-shard
  //    fragment-cache PRIMARY KEY (`graph_shard_fragment.shard_id`); two shards
  //    sharing an id silently overwrite each other's cache row, so the warm
  //    build never reaches a stable all-cached state and the function/entry-
  //    point counts drift run-to-run. A duplicate id is a discovery bug (e.g. a
  //    workspace-unit id derived by bare basename collapsing nested packages),
  //    never a recoverable runtime condition — so we throw rather than return a
  //    quietly-wrong graph.
  // @fitness-ignore-next-line detached-promises -- assertUniqueShardIds is a synchronous void assertion (throws on a duplicate id); there is no promise to await.
  assertUniqueShardIds(shards);

  // The seven canonical stages, mapped onto the sharded work so the live view
  // shows the same "Code Graph" checklist as the exact engine (ADR-0032). The
  // file set is fixed before any phase runs (shards are pre-enumerated), so the
  // `discover` stage is a zero-cost report of the partitioned total.
  const allFiles = shards.flatMap((s) => s.files);
  emitStageStart(onProgress, 'discover');
  emitStage(onProgress, 'discover', 0, `${String(allFiles.length)} files`);

  // 1. Decide which shards can be reused from cache vs must be rebuilt, then
  //    2. build the changed shards in parallel worker processes. Both fold into
  //    the `parse` stage (the heavy per-shard parse/walk/resolve runs inside the
  //    subprocesses) — its sub-label reflects the shard count.
  const parseStart = Date.now();
  emitStageStart(onProgress, 'parse');
  const plan = planShardWork(shards, catalogRepo, adapter, resolutionMode, useCache);
  const built = await runShardsInParallel({
    shards: plan.toBuild,
    projectRoot,
    cliScript,
    resolutionMode,
    concurrency: input.concurrency,
    ...(input.language === undefined ? {} : { language: input.language }),
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
  const shardWord = shards.length === 1 ? 'shard' : 'shards';
  emitStage(onProgress, 'parse', Date.now() - parseStart, `${String(shards.length)} ${shardWord}`);

  // 3a. Merge cached + freshly-built fragments — the `walk` stage. Mirrors the
  //     single-program walk: it assembles the per-file occurrences into one
  //     catalog, so its sub-label reports the resulting function count.
  const fragments = [...plan.cached, ...built.fragments];
  // The export linker keys packages by name; build the manifest index once from
  // the resolved shard set (each shard.rootDir holds a package.json) so the
  // boundary resolver can turn a bare specifier into a target package group.
  const manifestIndex = buildPackageManifestIndex(shards, projectRoot);
  const walkStart = Date.now();
  emitStageStart(onProgress, 'walk');
  const merged = mergeShardFragments(
    fragments.map((f) => f.fragment),
    allFiles,
  );
  emitStage(
    onProgress,
    'walk',
    Date.now() - walkStart,
    `${String(countCatalogFunctions(merged))} functions`,
  );

  // 3b. Resolve the cross-shard boundary calls against the export index — graph's
  //     main-thread analogue of the single-program `resolve` stage — then stamp
  //     packages + drop name-guessed cross-package edges that contradict the import
  //     graph (same correction as the single-program path). Timed for REAL (not a
  //     hardcoded 0): the per-shard intra-package resolution already ran inside the
  //     shard subprocesses (the `parse`/build-shards stage), so this stage is the
  //     cross-package linking + constraint pass. Sub-label is the catalog-derived
  //     resolved-call-site count, identical metric to the exact path.
  const resolveStart = Date.now();
  emitStageStart(onProgress, 'resolve');
  const boundaryCalls = fragments.flatMap((f) => f.boundaryCalls);
  const { catalog: resolved, boundaryStats } = resolveCrossBoundaryCalls(
    merged,
    boundaryCalls,
    manifestIndex,
  );
  const catalog = stampAndConstrainPackages(resolved, projectRoot);
  emitStage(
    onProgress,
    'resolve',
    Date.now() - resolveStart,
    `${String(countCatalogCallSites(catalog))} call site(s)`,
  );

  // 4. Derive indexes + features over the unified catalog. Features run once
  //    here on the merged global catalog (not per shard), after merge / before
  //    rules — the same stage order as the single-program path.
  const indexStart = Date.now();
  emitStageStart(onProgress, 'index');
  const indexes = buildIndexes(catalog);
  emitStage(onProgress, 'index', Date.now() - indexStart);
  const ruleSet = input.rules ?? currentRules();
  const config: GraphConfig = input.config ?? {};
  const requestedColumns = unionFeatureDeps(ruleSet, input.emitFeatures);
  const featuresStart = Date.now();
  emitStageStart(onProgress, 'features');
  const features = buildFeatures(catalog, indexes, config, requestedColumns);
  emitStage(onProgress, 'features', Date.now() - featuresStart);
  const persistedFeatures = toPersistedFeatures(features, requestedColumns);
  const persisted = isPersistedFeaturesEmpty(persistedFeatures) ? undefined : persistedFeatures;
  // The catalog persisted (and returned) carries the materialized dashboard
  // columns when requested; otherwise the bare catalog (lean default).
  const catalogToPersist: Catalog = persisted ? { ...catalog, features: persisted } : catalog;

  // 5. Persist: each rebuilt shard's fragment, prune removed shards, and the
  //    unified full catalog (with materialized features when requested) so
  //    whole-catalog consumers (incl. the dashboard) still work.
  if (useCache && catalogRepo) {
    // @fitness-ignore-next-line detached-promises -- persistShardedCatalog is a synchronous void helper (better-sqlite3/Drizzle writes); there is no promise to await.
    persistShardedCatalog(catalogRepo, built.fragments, shards, catalogToPersist);
  }

  // 6. Run rules over the unified catalog, threading the feature table (5th arg).
  const rulesStart = Date.now();
  emitStageStart(onProgress, 'rules');
  const signals: Signal[] = [];
  for (const rule of ruleSet) {
    // Indexed append rather than spread-in-loop — avoids re-allocating the
    // accumulator on every rule (O(n²)) over a potentially large rule set.
    const ruleSignals = rule.evaluate(catalog, indexes, config, adapter.ruleHints, features);
    for (const signal of ruleSignals) signals.push(signal);
  }
  emitStage(
    onProgress,
    'rules',
    Date.now() - rulesStart,
    `${String(ruleSet.length)} rule(s), ${String(signals.length)} signal(s)`,
  );

  span.setAttributes({
    'opensip_tools.graph.shards_built': plan.toBuild.length,
    'opensip_tools.graph.shards_cached': plan.cached.length,
    'opensip_tools.graph.shards_failed': built.failures.length,
  });
  const shardStats: ShardRunStats = {
    shardCount: shards.length,
    shardsBuilt: plan.toBuild.length,
    shardsCached: plan.cached.length,
    shardSizes: shards.map((s) => s.files.length).sort((a, b) => b - a),
    boundaryCallSites: boundaryCalls.length,
  };
  return {
    catalog: catalogToPersist,
    indexes,
    signals,
    resolutionStats: boundaryStats,
    cacheHit: plan.toBuild.length === 0,
    failedShardIds: built.failures.map((f) => f.shardId),
    features,
    shardStats,
  };
}

/**
 * Persist the rebuilt shard fragments, prune fragments for removed shards, and
 * write the unified catalog — best-effort (a failed catalog write is logged, not
 * thrown: the freshly-built result is returned regardless). Extracted so
 * {@link buildShardedGraph} stays under the cognitive-complexity bound.
 */
function persistShardedCatalog(
  catalogRepo: CatalogRepo,
  builtFragments: readonly ShardBuildResult[],
  shards: readonly Shard[],
  catalogToPersist: Catalog,
): void {
  // @fitness-ignore-next-line detached-promises -- CatalogRepo is synchronous (better-sqlite3/Drizzle); upsertShardFragment returns void, not a Promise.
  for (const fragment of builtFragments) catalogRepo.upsertShardFragment(fragment);
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

/** Emit a `stage-start` for `stage` (no-op when no callback). */
function emitStageStart(onProgress: GraphProgressCallback | undefined, stage: GraphStage): void {
  onProgress?.({ type: 'stage-start', stage });
}

/** Emit a `stage-done` for `stage` with its duration + optional checklist detail. */
function emitStage(
  onProgress: GraphProgressCallback | undefined,
  stage: GraphStage,
  durationMs: number,
  detail?: string,
): void {
  onProgress?.({
    type: 'stage-done',
    stage,
    durationMs,
    ...(detail === undefined ? {} : { detail }),
  });
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
