/**
 * Engine-version cache invalidation (ADR-0015).
 *
 * The persisted catalog and per-shard fragment caches let a re-run skip
 * parse/walk/resolve when nothing relevant changed. Their validity is
 * keyed on the adapter `cacheKey` (config + tool-version hash) and a
 * per-file fingerprint — but NOT on the version of the graph engine that
 * produced them. So upgrading opensip-cli to a build with changed
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

import { readPackageVersion } from '@opensip-cli/core';

import { NEAR_DUP_SIGNATURE_K } from '../lang-adapter/near-duplicate-signature.js';

/**
 * The running `@opensip-cli/graph` package version, resolved once from
 * the nearest `package.json`. In a published install this is the version
 * npm placed on disk; in the monorepo it is `graph/engine`'s version.
 */
export const ENGINE_VERSION = readPackageVersion(import.meta.url);

/** Cache-key prefix carrying the engine version. */
const ENGINE_VERSION_PREFIX = 'eng=';

/**
 * The two build engines whose catalogs share the single `graph_catalog`
 * row (id=1). The exact engine (single-program `runGraph`) and the sharded
 * engine resolve cross-package edges through ONE shared hop (exact = the
 * 1-shard case), held equivalent by the directional soundness invariant +
 * completeness floor (ADR-0033, supersedes ADR-0032), but
 * the mode is still folded into the `cacheKey` (below) so a mode switch is a
 * clean, attributable cache miss rather than a silent cross-engine read of a
 * row built under different orchestration — keeping the two cache lineages
 * independent and the invalidate logs diagnosable.
 *
 * Determinism (ADR-0032, superseding ADR-0031): the default `graph` uses
 * `'sharded'` when the project is shardable; `'exact'` is reached via the
 * explicit `--exact` opt-out or when the project isn't shardable.
 */
export type EngineMode = 'exact' | 'sharded';

/** Cache-key segment carrying the build engine mode. */
const ENGINE_MODE_PREFIX = 'mode=';

/** Cache-key segment carrying the near-duplicate signature schema version. */
const SIGNATURE_VERSION_PREFIX = 'sig=';

/**
 * Prefix an adapter's `cacheKey` with the running engine version AND the
 * build engine mode so (a) a tool upgrade invalidates persisted
 * catalogs/fragments, and (b) the exact and sharded engines — which write
 * the same `graph_catalog` row — keep independent cache lineages and never
 * read each other's row. Applied at every engine-side cacheKey computation
 * (build-time stamp + both reuse-decision comparisons), so the stamped and
 * compared keys always agree.
 *
 * `mode` defaults to `'exact'` because the single-program `runGraph` path IS
 * the exact engine and stamps the default; the (now-default) sharded path
 * passes `'sharded'` explicitly, including when it derives the merged
 * build-level key from the per-shard keys.
 *
 * The result stays an opaque string per the `Catalog.cacheKey` contract;
 * the `eng=<version>|mode=<mode>|` prefix is human-legible in the
 * invalidate logs (`cached:`/`current:`) so a version- or mode-driven
 * rebuild is diagnosable.
 */
export function stampEngineVersion(adapterCacheKey: string, mode: EngineMode = 'exact'): string {
  return `${ENGINE_VERSION_PREFIX}${ENGINE_VERSION}|${ENGINE_MODE_PREFIX}${mode}|${SIGNATURE_VERSION_PREFIX}${String(NEAR_DUP_SIGNATURE_K)}|${adapterCacheKey}`;
}
