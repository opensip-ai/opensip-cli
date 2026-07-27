/**
 * TypeScript cacheKey implementation.
 *
 * Produces `ts-${ts.version}-adapter-${adapterVersion}-${resolutionMode}-${resolvedTsconfigHash}`.
 * Stored in Catalog.cacheKey (v3 shape introduced by the language-pluggability
 * work). Replaces the v2 fields `tsCompilerVersion` and `tsConfigPath` that lived
 * as separate top-level catalog properties.
 *
 * The resolution mode is part of the key so a fast catalog and an exact catalog
 * for the same tsconfig occupy distinct `cache_key` rows in the datastore —
 * switching `--resolution` is a clean cache miss against the other tier, never a
 * wrong-tier reuse. No schema change is needed; the existing `cache_key` column
 * carries the mode.
 *
 * F2 — RESOLVED tsconfig (extends-aware). Earlier this hashed only the NAMED
 * tsconfig file's RAW content. But package tsconfigs `extends` a shared base
 * (`tsconfig.base.json`), and editing the base's `paths`/`baseUrl`/
 * `moduleResolution` changes module resolution → different edges — WITHOUT
 * changing the named file's bytes. Every shard fragment would then cache-hit a
 * stale fragment → a silently-wrong graph (`--no-cache` recovers, but only if you
 * know to). We now hash the RESOLVED `compilerOptions` (TS walks the `extends`
 * chain for us via `parseJsonConfigFileContent`), stable-stringified, so any
 * extends-base edit that affects resolution invalidates the key.
 *
 * F5 — adapter package version. The engine version is folded in separately at
 * the engine boundary (`stampEngineVersion`, ADR-0015), but a
 * `@opensip-cli/graph-typescript` resolver fix shipped WITHOUT an engine
 * version bump (possible under independent versioning, ADR-0012) would reuse
 * stale fragments. Folding the adapter's OWN package version closes that:
 * belt-and-suspenders while engine + adapters ship in lockstep (3.0.0 today),
 * load-bearing the moment they diverge.
 *
 * Per contract invariant I-6 (cacheKey is stable for stable input): the function
 * is purely a function of
 * `(ts.version, adapterVersion, resolutionMode, resolvedTsconfigOptions)`. If the
 * tsconfig file is missing/unreadable on disk we fall back to a literal marker so
 * two calls without a (readable) tsconfig still match.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { logger, normalizeFailure, readPackageVersion } from '@opensip-cli/core';
import { graphErrorCatalog, throwIfGraphAdapterAborted } from '@opensip-cli/graph';
import ts from 'typescript';

import type { CacheKeyInput } from '@opensip-cli/graph';

/**
 * This adapter package's own version (ADR-0012 independent versioning). Resolved
 * once from the nearest package.json, memoized in core's `readPackageVersion`.
 */
const ADAPTER_VERSION = readPackageVersion(import.meta.url);
const TSCONFIG_NOT_FOUND = graphErrorCatalog.require('GRAPH.TSCONFIG.NOT_FOUND');
const TSCONFIG_INVALID = graphErrorCatalog.require('GRAPH.TSCONFIG.INVALID');
const TSCONFIG_LOAD_FAILED = graphErrorCatalog.require('GRAPH.TSCONFIG.LOAD_FAILED');

type ConfigHashFailureCondition =
  'config-missing' | 'config-read-failed' | 'config-invalid' | 'resolved-config-failed';

export function cacheKey(input: CacheKeyInput): string {
  throwIfGraphAdapterAborted(input.signal, 'TypeScript cache-key computation');
  const tsconfigHash = hashResolvedTsconfig(input.configPathAbs, input.signal);
  throwIfGraphAdapterAborted(input.signal, 'TypeScript cache-key computation');
  return `ts-${ts.version}-adapter-${ADAPTER_VERSION}-${input.resolutionMode}-${tsconfigHash}`;
}

/**
 * Hash the RESOLVED tsconfig — the effective `compilerOptions` after TS walks the
 * `extends` chain — rather than the named file's raw bytes. So an edit to a
 * shared `tsconfig.base.json`'s `paths`/`baseUrl`/`moduleResolution` that the
 * named config `extends` changes the key (the fragments rebuild), not a stale hit.
 */
function hashResolvedTsconfig(configPathAbs: string | undefined, signal?: AbortSignal): string {
  if (configPathAbs === undefined || configPathAbs.length === 0) {
    return 'no-tsconfig';
  }
  if (!existsSync(configPathAbs)) {
    return configHashFallback('config-missing');
  }
  let read: ReturnType<typeof ts.readConfigFile>;
  try {
    read = ts.readConfigFile(configPathAbs, (path) => ts.sys.readFile(path));
  } catch (error) {
    return configHashFallback('config-read-failed', error);
  }
  if (read.error !== undefined || read.config === undefined) {
    const diagnosticCode = read.error?.code;
    return configHashFallback(
      diagnosticCode === 5083 ? 'config-read-failed' : 'config-invalid',
      undefined,
      diagnosticCode,
    );
  }
  // parseJsonConfigFileContent follows `extends` and merges the effective
  // compilerOptions. We hash ONLY the resolved compilerOptions (the
  // resolution-affecting surface) — not the full parsed file list, which is a
  // function of on-disk globs the per-file fingerprint already covers.
  let parsed: ts.ParsedCommandLine;
  try {
    parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      dirname(configPathAbs),
      undefined,
      configPathAbs,
    );
  } catch (error) {
    return configHashFallback('resolved-config-failed', error);
  }
  throwIfGraphAdapterAborted(signal, 'TypeScript config hashing');
  return createHash('sha256').update(stableStringify(parsed.options)).digest('hex').slice(0, 16);
}

function configHashFallback(
  condition: ConfigHashFailureCondition,
  error?: unknown,
  diagnosticCode?: number,
): string {
  let boundary = TSCONFIG_LOAD_FAILED;
  if (condition === 'config-missing') boundary = TSCONFIG_NOT_FOUND;
  else if (condition === 'config-invalid') boundary = TSCONFIG_INVALID;
  const failure = error === undefined ? undefined : normalizeFailure(error);
  logger.warn({
    evt: 'graph.adapter.tsconfig_hash_degraded',
    module: 'graph:adapter-typescript',
    code: failure?.known === 'known' ? failure.code : boundary.code,
    boundaryCode: boundary.code,
    condition,
    diagnosticCode,
    errno: failure?.metadata.errno,
    msg: 'TypeScript configuration could not be fingerprinted; a location-independent cache marker is used',
  });
  return condition === 'config-missing' ? 'missing-tsconfig' : 'unreadable-tsconfig';
}

/**
 * Stable JSON of an object: keys sorted so the hash is independent of TS's
 * internal property-insertion order. Values are TS's resolved compilerOptions
 * primitives (strings/numbers/booleans/enums) — JSON-serializable; the
 * `configFilePath`/`pathsBasePath` absolute-path fields are dropped so the key
 * is location-independent (a checkout under a different absolute root still
 * hits).
 */
function stableStringify(options: ts.CompilerOptions): string {
  const LOCATION_KEYS = new Set(['configFilePath', 'pathsBasePath']);
  const entries = Object.entries(options as Record<string, unknown>)
    .filter(([k]) => !LOCATION_KEYS.has(k))
    .sort(([a], [b]) => Number(a > b) - Number(a < b));
  return JSON.stringify(entries);
}
