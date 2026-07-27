/**
 * Shared config-fingerprint helpers for the tree-sitter adapters'
 * `cacheKey`.
 *
 * `hashConfig(configPathAbs)` is byte-identical in graph-go / graph-java /
 * graph-rust: it returns the literal `no-config` when no anchor exists,
 * `missing:<path>` / `unreadable:<path>` sentinels on fs failure, and the
 * first 16 hex chars of the sha256 of the manifest content otherwise. Per
 * contract invariant I-6 it is a pure function of the config content.
 *
 * `makeConfigCacheKey({ prefix })` returns the trivial
 * `cacheKey(input) => `${prefix}-${hashConfig(...)}-${resolutionMode}`` used by go/java/rust
 * (with prefixes `go-` / `java-` / `rs-`). Python keeps its own
 * `cache-key.ts` but imports `hashConfig` from here and layers its
 * `requires-python` extraction on top (DEC-4).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { throwIfGraphAdapterAborted } from '@opensip-cli/graph';

import type { CacheKeyInput } from '@opensip-cli/graph';

/**
 * Fingerprint a language config file's content.
 *
 *   - `undefined` / empty path → `'no-config'`
 *   - path does not exist      → `'missing:<path>'`
 *   - read fails               → `'unreadable:<path>'`
 *   - otherwise                → first 16 hex of sha256(content)
 */
export function hashConfig(configPathAbs: string | undefined, signal?: AbortSignal): string {
  throwIfGraphAdapterAborted(signal, 'config hashing');
  if (configPathAbs === undefined || configPathAbs.length === 0) {
    return 'no-config';
  }
  if (!existsSync(configPathAbs)) {
    return `missing:${configPathAbs}`;
  }
  let hash: string;
  try {
    const content = readFileSync(configPathAbs, 'utf8');
    hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    /* v8 ignore next */
    return `unreadable:${configPathAbs}`;
  }
  throwIfGraphAdapterAborted(signal, 'config hashing');
  return hash;
}

/**
 * Builds a `cacheKey` that emits
 * `${prefix}-${hashConfig(configPathAbs)}-${resolutionMode}`.
 * Per I-8 the prefix must be distinct per adapter (`go-`, `java-`, `rs-`).
 */
export function makeConfigCacheKey(options: {
  readonly prefix: string;
}): (input: CacheKeyInput) => string {
  const { prefix } = options;
  return function cacheKey(input: CacheKeyInput): string {
    return `${prefix}-${hashConfig(input.configPathAbs, input.signal)}-${input.resolutionMode}`;
  };
}
