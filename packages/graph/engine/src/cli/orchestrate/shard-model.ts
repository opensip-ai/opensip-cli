/**
 * Shard model and the serializable worker-boundary contract.
 *
 * A sharded build splits a multi-package project into independent shards
 * (one workspace package, one `--packages` unit, or one flat-monorepo
 * partition), builds each in its own worker process, and merges the
 * per-shard catalog fragments — recovering the cross-package edges the
 * old fan-out modes silently dropped.
 *
 * The load-bearing constraint: a worker process cannot hand back a
 * `ts.Node` / `ts.Program` (not structured-cloneable). So every type that
 * crosses the worker boundary here is JSON-safe by construction — a
 * primitive, an array, or a `Catalog` (already the plain shape persisted
 * to the datastore today). The boundary carries DATA, never ASTs.
 *
 * Lifecycle:
 *   discovery → Shard[]                      (workspace/packages/partition)
 *   worker(Shard) → ShardBuildResult          (Phase 1, per process)
 *   merge(fragments) + resolve(boundaryCalls) (Phase 2, main thread)
 *   cache(fragment by shardId+fingerprint)    (Phase 3)
 */

import type { Catalog, CrossBoundaryCall, ParseError, ResolutionMode } from '../../types.js';

// `CrossBoundaryCall` lives in the shared engine type layer (`types.ts`)
// because the adapter contract (`lang-adapter/types.ts` → `ResolveOutput`)
// emits it — only the adapter can extract a callee name syntactically.
// Re-exported here so shard-model consumers see it on the shard surface.
export type { CrossBoundaryCall } from '../../types.js';

/**
 * One parallelizable unit of a sharded build. The discovery strategies
 * (workspace units, flat-monorepo partitions) map their output onto this
 * single shape.
 */
export interface Shard {
  /** Stable shard id, e.g. `'pkg:core'`, `'partition:3'`. Used as the cache key component. */
  readonly id: string;
  /** Absolute root dir the shard's files live under. */
  readonly rootDir: string;
  /** Absolute file paths belonging to this shard (already enumerated — no re-discovery). */
  readonly files: readonly string[];
  /** Absolute path to the shard's config anchor (tsconfig.json, etc.), if any. */
  readonly configPathAbs?: string;
}

/**
 * The JSON spec a shard worker reads (written by the runner to a temp
 * file, path passed via argv — file, not argv, so thousands of file
 * paths don't overflow the command line).
 */
export interface ShardWorkerSpec {
  readonly shard: Shard;
  /**
   * The COMMON project root all shards share. The worker computes every
   * occurrence's project-relative `filePath` against this root (not the
   * shard's own rootDir) so fragments from different shards align in the
   * merged catalog.
   */
  readonly projectRoot: string;
  readonly resolutionMode: ResolutionMode;
}

/**
 * The serializable result one shard worker returns. JSON-safe by
 * construction — round-trips losslessly through
 * `JSON.parse(JSON.stringify(result))` (the worker-boundary contract,
 * asserted in Phase 5 tests).
 */
export interface ShardBuildResult {
  readonly shardId: string;
  /**
   * This shard's catalog: its occurrences plus every edge the worker
   * could resolve LOCALLY (semantic in exact mode, syntactic in fast).
   */
  readonly fragment: Catalog;
  /** Per-shard files fingerprint (mtime+size) — the per-shard cache validity key. */
  readonly fingerprint: string;
  /**
   * Call sites the worker could not resolve within its own files — the
   * candidates the cross-shard pass re-resolves against the global catalog.
   */
  readonly boundaryCalls: readonly CrossBoundaryCall[];
  readonly parseErrors: readonly ParseError[];
}
