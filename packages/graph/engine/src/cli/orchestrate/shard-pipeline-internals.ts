/**
 * @fileoverview Re-export barrel for `sharded-graph.ts`'s own sibling
 * modules — the shard-pipeline's shape (`types.ts`, `shard-model.ts`),
 * planning/running (`shard-runner.ts`), and merge/stats
 * (`cross-shard-resolve.ts`, `catalog-stats.ts`, `catalog-build-coverage.ts`).
 *
 * These six files are one cohesive sub-area (the sharded-build pipeline
 * that `sharded-graph.ts` threads together); importing them individually
 * inflated `sharded-graph.ts`'s outbound fan-out with same-subsystem
 * sibling edges rather than real cross-subsystem coupling. Consolidating
 * behind one barrel keeps the fan-out signal meaningful (cache / pipeline /
 * rules / cross-package — the actual external subsystems it coordinates)
 * without losing any of the re-exported functionality.
 */

export { catalogBuildCoverage } from './catalog-build-coverage.js';
export { countCatalogCallSites, countCatalogFunctions } from './catalog-stats.js';
export {
  mergeShardFragments,
  reattributeDeclarationDependencies,
  resolveCrossBoundaryCalls,
  stampAndConstrainPackages,
} from './cross-shard-resolve.js';
export { boundedShardFailureEvidence, planShardWork, runShardsInParallel } from './shard-runner.js';

export type { Shard, ShardBuildResult, ShardRunStats } from './shard-model.js';
export type {
  GraphProgressCallback,
  GraphStage,
  RunShardedInput,
  RunShardedResult,
} from './types.js';
