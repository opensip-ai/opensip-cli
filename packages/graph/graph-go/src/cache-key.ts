/**
 * Go cacheKey implementation.
 *
 * Produces `go-${goSumHash || goModHash || 'no-config'}`.
 *
 * Prefers go.sum over go.mod when both are present — go.sum holds the
 * resolved dependency tree (with hashes), so changing a dep version
 * reliably flips the key. go.mod (the manifest) is the fallback when
 * go.sum isn't checked in (rare; Go conventionally commits it).
 *
 * Per contract invariant I-6: pure function of `(config content)`.
 * Per I-8: emits `go-`, distinct from `rs-` and `py-`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import type { CacheKeyInput } from '@opensip-tools/graph';

export function cacheKey(input: CacheKeyInput): string {
  return `go-${hashConfig(input.configPathAbs)}`;
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
