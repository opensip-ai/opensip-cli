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

import type { Catalog, ParseError } from '../../types.js';

/**
 * One parallelizable unit of a sharded build. The three discovery
 * strategies (workspace units, `--packages`, flat-monorepo partitions)
 * all map their output onto this single shape.
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
 * A call site a shard worker could NOT resolve within its own files —
 * the callee name is not among the shard's own occurrences. Plain data
 * only: the cross-shard pass (Phase 2) re-resolves these against the
 * global merged catalog + import graph, syntactically.
 */
export interface CrossBoundaryCall {
  /** bodyHash of the enclosing function (an occurrence in this shard's fragment). */
  readonly ownerHash: string;
  /** Syntactic callee simple name (`foo` in `foo()`, rightmost in `a.b.c()`). */
  readonly calleeName: string;
  /** The import specifier the name came from, if it was imported (`'./x.js'`, `'@scope/pkg'`). */
  readonly importSpecifier?: string;
  /** 1-based line of the call site. */
  readonly line: number;
  /** 0-based column. */
  readonly column: number;
  /** Truncated call-expression text for display (≤ 80 chars, the CallEdge.text contract). */
  readonly text: string;
  /**
   * True when the call's return value is discarded (ExpressionStatement).
   * Carried so the recovered cross-shard CallEdge preserves the `discarded`
   * flag that `no-side-effect-path` relies on.
   */
  readonly discarded?: boolean;
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
