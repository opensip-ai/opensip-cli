// @fitness-ignore-file unbounded-memory -- reads pyproject.toml manifest; bounded by standard Python project metadata
/**
 * Python cacheKey implementation.
 *
 * Produces `py-${pythonVersion}-${pyprojectContentHash || 'no-config'}`.
 *
 * The "Python version" is best-effort: we look for a `requires-python`
 * line in `pyproject.toml` (PEP 621) — this is a string like
 * `>=3.10,<4.0` — and emit it verbatim. If we can't find one we fall
 * back to the literal `unknown`. This is a CACHE INVALIDATION key, not
 * a source-of-truth — its only job is to flip when the toolchain
 * intent changes.
 *
 * Per contract invariant I-6 (cacheKey is stable for stable input AND
 * changes when the language config changes): the function is purely a
 * function of `(pyproject content)`. Two calls without any pyproject
 * file produce the same `py-unknown-no-config` key.
 *
 * Per I-8 (different adapter prefixes): we emit `py-`, distinct from
 * the TypeScript adapter's `ts-` and the Rust adapter's `rs-`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import type { CacheKeyInput } from '@opensip-tools/graph';

// Anchored to start-of-line; horizontal whitespace ([\t ]) and the
// inner `[^"'\n]` keep matching linear. Using `\s` would cross
// newlines and let pathological inputs explore O(n^2) prefixes.
const REQUIRES_PYTHON_RE = /^[\t ]*requires-python[\t ]*=[\t ]*["']([^"'\n]+)["']/m;

export function cacheKey(input: CacheKeyInput): string {
  const { pythonVersion, configHash } = readConfig(input.configPathAbs);
  return `py-${pythonVersion}-${configHash}`;
}

function readConfig(configPathAbs: string | undefined): {
  readonly pythonVersion: string;
  readonly configHash: string;
} {
  if (configPathAbs === undefined || configPathAbs.length === 0) {
    return { pythonVersion: 'unknown', configHash: 'no-config' };
  }
  if (!existsSync(configPathAbs)) {
    return { pythonVersion: 'unknown', configHash: `missing:${configPathAbs}` };
  }
  let content: string;
  try {
    content = readFileSync(configPathAbs, 'utf8');
  } catch {
    /* v8 ignore next */
    return { pythonVersion: 'unknown', configHash: `unreadable:${configPathAbs}` };
  }
  const match = REQUIRES_PYTHON_RE.exec(content);
  const pythonVersion = match ? sanitize(match[1] ?? 'unknown') : 'unknown';
  const configHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return { pythonVersion, configHash };
}

function sanitize(s: string): string {
  // Keep cache-key strings shell- and filename-safe.
  return s.replaceAll(/[^A-Za-z0-9._+-]/g, '_').slice(0, 32);
}
