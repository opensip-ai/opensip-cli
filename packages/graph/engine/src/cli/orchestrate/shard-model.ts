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

// `CrossBoundaryCall` lives in the shared engine type layer (`types.ts`)
// because the adapter contract (`lang-adapter/types.ts` → `ResolveOutput`)
// emits it — only the adapter can extract a callee name syntactically.
// Consumers import it from `../../types.js` (or the package barrel) directly.
import type { Catalog, CrossBoundaryCall, ParseError, ResolutionMode } from '../../types.js';
import type { RunCorrelation } from '@opensip-cli/core';

/**
 * One parallelizable unit of a sharded build. The discovery strategies
 * (workspace units, flat-monorepo partitions) map their output onto this
 * single shape.
 */
export interface Shard {
  /**
   * Stable shard id, e.g. `'pkg:core'`, `'partition:3'`, or the synthetic
   * catch-all `':root'` ({@link partition-files.ROOT_SHARD_ID}). Used as the
   * per-shard fragment-cache primary key — MUST be unique across the shard set
   * (asserted by `assertUniqueShardIds`).
   */
  readonly id: string;
  /** Absolute root dir the shard's files live under. The `':root'` shard's rootDir is the project root. */
  readonly rootDir: string;
  /** Absolute file paths belonging to this shard (already enumerated — no re-discovery). */
  readonly files: readonly string[];
  /**
   * Absolute path to the shard's config anchor (tsconfig.json, etc.), if any.
   * For the synthetic `':root'` shard this is the ROOT tsconfig — the worker
   * builds that shard's files (root scripts, unowned/`.config` files) against
   * the root compiler options so they parse/resolve correctly (Phase 1).
   */
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
  /** Optional adapter id requested by the parent `graph --language <id>` run. */
  readonly language?: string;
  readonly resolutionMode: ResolutionMode;
  /**
   * OPTIONAL correlation bag forwarded from the parent run so the shard worker
   * can stamp `tool`/`parentCommand`/`traceId`/`shardId` on its spans and logs
   * (subprocess-correlation telemetry spec, Phase 1).
   *
   * Wire-compat seam: this field is OPTIONAL on purpose. A mismatched
   * parent↔worker build during a partial upgrade — an old worker reading a new
   * spec, or a new worker reading an old spec — MUST NOT break. A required field
   * would. If a hard contract is ever needed, version the envelope with a
   * `specVersion` field rather than making this required.
   *
   * `runId` is deliberately EXCLUDED (`Omit<…, 'runId'>`): it travels via the
   * `OPENSIP_RUN_ID` env ONLY (B1), inherited at the worker's pre-action hook
   * before any spec JSON is parsed.
   */
  readonly correlation?: Omit<RunCorrelation, 'runId'>;
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

/** Per-run sharded-build statistics, mirrored into the --profile summary
 *  (ADR-0045 measurement plane). All counts are plain numbers. */
export interface ShardRunStats {
  readonly shardCount: number;
  readonly shardsBuilt: number;
  readonly shardsCached: number;
  /** Files per shard, sorted descending (balance metric input). */
  readonly shardSizes: readonly number[];
  /** Total cross-shard boundary call sites handed to the linker. */
  readonly boundaryCallSites: number;
}
