import { createHash } from 'node:crypto';

import { compareCodePointStrings } from '../code-point-order.js';

import { stampEngineVersion } from './engine-version.js';

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\//;

export interface ShardedCatalogCacheKeyInput {
  readonly shardId: string;
  readonly rootDir: string;
  readonly configPath?: string;
  readonly cacheKey: string;
}

interface ShardedCatalogAnchor {
  readonly shardId: string;
  readonly rootDir: string;
  readonly configPath?: string;
}

/**
 * Validate a bounded project-relative POSIX anchor stored in sharded cache
 * provenance. `.` represents the configured project root.
 */
export function isSafeShardedCacheAnchor(value: unknown, maxLength: number): value is string {
  if (value === '.') return true;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.startsWith('/') ||
    value.includes('\\') ||
    WINDOWS_ABSOLUTE_PATH.test(value) ||
    /\p{Cc}/u.test(value)
  ) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Return shard provenance in deterministic identity order before persistence. */
export function sortShardedCatalogAnchors<T extends ShardedCatalogAnchor>(
  inputs: readonly T[],
): T[] {
  return [...inputs].sort((left, right) =>
    compareCodePointStrings(
      JSON.stringify([left.shardId, left.rootDir, left.configPath ?? null]),
      JSON.stringify([right.shardId, right.rootDir, right.configPath ?? null]),
    ),
  );
}

/**
 * Build the unified sharded-catalog cache key from the exact fragment cache
 * keys that feed the merge. Shared by the producer and freshness verifier.
 */
export function buildShardedCatalogCacheKey(
  inputs: readonly ShardedCatalogCacheKeyInput[],
): string {
  const tuples = inputs
    .map((input) => [input.shardId, input.rootDir, input.configPath ?? null, input.cacheKey])
    .sort((left, right) => compareCodePointStrings(JSON.stringify(left), JSON.stringify(right)));
  const merged = createHash('sha256').update(JSON.stringify(tuples), 'utf8').digest('hex');
  return stampEngineVersion(`sharded-${String(inputs.length)}-${merged}`, 'sharded');
}
