/**
 * TypeScript cacheKey implementation.
 *
 * Produces `ts-${ts.version}-${tsconfigContentHash}`. Stored in
 * Catalog.cacheKey (v3 shape introduced by PR 3 of plan
 * docs/plans/10-graph-language-pluggability.md). Replaces the v2
 * fields `tsCompilerVersion` and `tsConfigPath` that lived as
 * separate top-level catalog properties.
 *
 * Per contract invariant I-6 (cacheKey is stable for stable input):
 * the function is purely a function of `(ts.version, tsconfigContent)`.
 * If the tsconfig file is missing on disk we fall back to a literal
 * `no-tsconfig` marker so two calls without a tsconfig still match.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import ts from 'typescript';

import type { CacheKeyInput } from '../lang-adapter/types.js';

export function cacheKey(input: CacheKeyInput): string {
  const tsconfigHash = hashTsconfig(input.configPathAbs);
  return `ts-${ts.version}-${tsconfigHash}`;
}

function hashTsconfig(configPathAbs: string | undefined): string {
  if (configPathAbs === undefined || configPathAbs.length === 0) {
    return 'no-tsconfig';
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
