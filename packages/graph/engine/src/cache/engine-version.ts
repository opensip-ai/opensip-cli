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
 * Prefix an adapter's `cacheKey` with the running engine version so a
 * tool upgrade invalidates persisted catalogs/fragments. Applied at every
 * engine-side cacheKey computation (build-time stamp + both reuse-decision
 * comparisons), so the stamped and compared keys always agree.
 *
 * The result stays an opaque string per the `Catalog.cacheKey` contract;
 * the `eng=<version>|` prefix is human-legible in the invalidate logs
 * (`cached:`/`current:`) so a version-driven rebuild is diagnosable.
 */
export function stampEngineVersion(adapterCacheKey: string): string {
  return `${ENGINE_VERSION_PREFIX}${ENGINE_VERSION}|${adapterCacheKey}`;
}
