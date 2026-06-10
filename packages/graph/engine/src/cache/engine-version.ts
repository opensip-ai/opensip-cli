/**
 * Engine-version cache invalidation (ADR-0015).
 *
 * The persisted catalog and per-shard fragment caches let a re-run skip
 * parse/walk/resolve when nothing relevant changed. Their validity is
 * keyed on the adapter `cacheKey` (config + tool-version hash) and a
 * per-file fingerprint — but NOT on the version of the graph engine that
 * produced them. So upgrading opensip-tools to a build with changed
 * catalog-construction logic (edge resolution, body hashing, a new
 * rule-relevant field) would replay a stale catalog when the source was
 * unchanged: the customer analog of running a stale compiled binary.
 *
 * Fix: fold the running engine's package version into the `cacheKey` at
 * the (language-agnostic) engine boundary, so ANY tool upgrade
 * invalidates the cache for EVERY adapter — TypeScript and the
 * tree-sitter languages alike — and the next run rebuilds with the
 * engine the user actually installed. Over-invalidation (a no-op release
 * triggers one cold rebuild) is the deliberately safe default.
 *
 * Stamping lives in the existing `cacheKey` channel (not a parallel
 * field) precisely because both cache paths — `classifyCatalog` for the
 * full catalog and `planShardWork`/`loadValidShardFragment` for shard
 * fragments — already invalidate on `cacheKey` mismatch. One stamp,
 * both caches, all languages, and no datastore migration: a pre-stamp
 * catalog simply mismatches the new prefix and rebuilds once.
 */

import { readPackageVersion } from '@opensip-tools/core';

/**
 * The running `@opensip-tools/graph` package version, resolved once from
 * the nearest `package.json`. In a published install this is the version
 * npm placed on disk; in the monorepo it is `graph/engine`'s version.
 */
export const ENGINE_VERSION = readPackageVersion(import.meta.url);

/** Cache-key prefix carrying the engine version. */
const ENGINE_VERSION_PREFIX = 'eng=';

/**
 * The two build engines whose catalogs share the single `graph_catalog`
 * row (id=1). The exact engine (single-program `runGraph`) and the
 * approximate sharded engine produce STRUCTURALLY DIFFERENT catalogs (they
 * disagree by ~2,400 functions on a large repo), so a consumer must never
 * read a catalog built by the engine it did not expect. The mode is folded
 * into the `cacheKey` (below) so a mode switch is a clean, attributable
 * cache miss — never a silent cross-engine read of a clobbered row.
 *
 * Phase 2 (determinism): the default `graph` always uses `'exact'`;
 * `'sharded'` is reached only via the explicit `--sharded` opt-in.
 */
export type EngineMode = 'exact' | 'sharded';

/** Cache-key segment carrying the build engine mode. */
const ENGINE_MODE_PREFIX = 'mode=';

/**
 * Prefix an adapter's `cacheKey` with the running engine version AND the
 * build engine mode so (a) a tool upgrade invalidates persisted
 * catalogs/fragments, and (b) the exact and sharded engines — which write
 * the same `graph_catalog` row but produce incompatible catalogs — never
 * read each other's row. Applied at every engine-side cacheKey computation
 * (build-time stamp + both reuse-decision comparisons), so the stamped and
 * compared keys always agree.
 *
 * `mode` defaults to `'exact'` because the single-program path (its only
 * historical caller) IS the exact engine; the sharded path passes
 * `'sharded'` explicitly, including when it derives the merged build-level
 * key from the per-shard keys.
 *
 * The result stays an opaque string per the `Catalog.cacheKey` contract;
 * the `eng=<version>|mode=<mode>|` prefix is human-legible in the
 * invalidate logs (`cached:`/`current:`) so a version- or mode-driven
 * rebuild is diagnosable.
 */
export function stampEngineVersion(
  adapterCacheKey: string,
  mode: EngineMode = 'exact',
): string {
  return `${ENGINE_VERSION_PREFIX}${ENGINE_VERSION}|${ENGINE_MODE_PREFIX}${mode}|${adapterCacheKey}`;
}
