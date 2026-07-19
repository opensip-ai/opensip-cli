/**
 * Shared types for the graph orchestration pipeline. Extracted into a
 * leaf module so the orchestrator (`../orchestrate.ts`) and its
 * helpers (`cache-orchestrator.ts`, `catalog-builder.ts`) can all
 * reference the same `GraphStage` / `GraphProgressCallback` shapes
 * without forming a file-level cycle.
 *
 * Previously these lived in `../orchestrate.ts` and the helpers
 * type-imported them back from there — closing a cycle the
 * `circular-import-detection` check flagged. Hosting the types here
 * inverts the dependency: the orchestrator and both helpers now
 * import from this leaf, and nothing in this file imports back.
 */

import type { Shard, ShardFailureEvidence, ShardRunStats } from './shard-model.js';
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
import type { Signal } from '@opensip-cli/core';

/** Canonical pipeline stages, in execution order. */
export type GraphStage = 'discover' | 'parse' | 'walk' | 'resolve' | 'index' | 'features' | 'rules';

/** Stage order — consumed by the live view to render the checklist. */
export const GRAPH_STAGES: readonly GraphStage[] = [
  'discover',
  'parse',
  'walk',
  'resolve',
  'index',
  'features',
  'rules',
];

/**
 * Structured progress event. `stage-cached` fires for parse/walk/resolve
 * when the on-disk catalog cache satisfies the run; the view renders
 * those stages as "(cached)" instead of running them.
 */
export interface GraphProgressEvent {
  readonly type: 'stage-start' | 'stage-done' | 'stage-cached';
  readonly stage: GraphStage;
  readonly durationMs?: number;
  readonly detail?: string;
}

/** Callback invoked with each {@link GraphProgressEvent} during graph orchestration. */
export type GraphProgressCallback = (event: GraphProgressEvent) => void;

/**
 * Input to the sharded graph pipeline: planned shards plus shared build,
 * persistence, rule, feature, and progress context.
 */
export interface RunShardedInput {
  readonly shards: readonly Shard[];
  /** Common project root; every fragment path resolves against it. */
  readonly projectRoot: string;
  /** CLI entry script (`process.argv[1]`) used to spawn shard workers. */
  readonly cliScript: string;
  readonly adapter: GraphLanguageAdapter;
  /** Optional adapter id requested by `graph --language <id>`. */
  readonly language?: string;
  readonly resolutionMode: ResolutionMode;
  readonly concurrency?: number;
  readonly useCache: boolean;
  readonly catalogRepo: CatalogRepo | null;
  readonly config?: GraphConfig;
  readonly rules?: readonly Rule[];
  /** Dashboard feature columns to materialize into the persisted catalog. */
  readonly emitFeatures?: readonly FeatureColumn[];
  /** Optional structured progress callback over the canonical graph stages. */
  readonly onProgress?: GraphProgressCallback;
}

/** Unified sharded graph result with cache, failure, feature, and profile evidence. */
export interface RunShardedResult {
  readonly catalog: Catalog;
  readonly indexes: Indexes;
  readonly signals: readonly Signal[];
  readonly resolutionStats: ResolutionStats;
  /** True when every shard was reused from cache. */
  readonly cacheHit: boolean;
  /** Shard ids whose worker failed while the remaining build continued. */
  readonly failedShardIds: readonly string[];
  /** Bounded reason evidence for each failed worker, in stable shard-id order. */
  readonly shardFailures: readonly ShardFailureEvidence[];
  /** Feature table derived over the merged global catalog. */
  readonly features: FeatureTable;
  /** Per-run sharded build statistics mirrored into profile output. */
  readonly shardStats: ShardRunStats;
}
