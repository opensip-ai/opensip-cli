// @fitness-ignore-file unbounded-memory -- reads Cargo.lock / Cargo.toml manifests; bounded by standard Rust crate metadata
/**
 * Rust cacheKey implementation.
 *
 * Produces `rs-${cargoLockHash || cargoTomlHash || 'no-config'}`.
 *
 * Prefers Cargo.lock over Cargo.toml when both are present —
 * Cargo.lock holds the resolved dependency graph, so changing a dep
 * version (which can change call-graph topology indirectly through
 * trait-impl changes) reliably flips the key. Cargo.toml is the
 * fallback when Cargo.lock isn't checked in (the typical pattern for
 * library crates).
 *
 * Per contract invariant I-6: pure function of `(config content)`.
 * Per I-8: emits `rs-`, distinct from `ts-` and `py-`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import type { CacheKeyInput } from '@opensip-tools/graph';

export function cacheKey(input: CacheKeyInput): string {
  return `rs-${hashConfig(input.configPathAbs)}`;
}

function hashConfig(configPathAbs: string | undefined): string {
  if (configPathAbs === undefined || configPathAbs.length === 0) {
    return 'no-config';
  }
  if (!existsSync(configPathAbs)) {
    return `missing:${configPathAbs}`;
  }
  try {
    const content = readFileSync(configPathAbs, 'utf8');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    /* v8 ignore next */
    return `unreadable:${configPathAbs}`;
  }
}
