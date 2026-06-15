// @fitness-ignore-file unbounded-memory -- reads pyproject.toml manifest; bounded by standard Python project metadata
/**
 * Python cacheKey implementation.
 *
 * Produces `py-${pythonVersion}-${pyprojectContentHash || 'no-config'}`.
 *
 * The content-fingerprint half (`no-config` / `missing:` / `unreadable:` /
 * sha256-prefix) is the byte-identical `hashConfig` contract shared with
 * go/java/rust; Python imports it from
 * `@opensip-cli/graph-adapter-common` and layers a best-effort
 * "Python version" on top (DEC-4). The version comes from a
 * `requires-python` line in `pyproject.toml` (PEP 621) — a string like
 * `>=3.10,<4.0`, sanitized; absent → the literal `unknown`. It is a CACHE
 * INVALIDATION key, not a source of truth — its only job is to flip when
 * the toolchain intent changes.
 *
 * Per contract invariant I-6 the function is purely a function of
 * `(pyproject content)`. Per I-8 we emit `py-`, distinct from the other
 * adapters' prefixes.
 */

import { existsSync, readFileSync } from 'node:fs';

import { hashConfig } from '@opensip-cli/graph-adapter-common';

import type { CacheKeyInput } from '@opensip-cli/graph';

// Anchored to start-of-line; horizontal whitespace ([\t ]) and the
// inner `[^"'\n]` keep matching linear. Using `\s` would cross
// newlines and let pathological inputs explore O(n^2) prefixes.
const REQUIRES_PYTHON_RE = /^[\t ]*requires-python[\t ]*=[\t ]*["']([^"'\n]+)["']/m;

export function cacheKey(input: CacheKeyInput): string {
  const configHash = hashConfig(input.configPathAbs);
  const pythonVersion = readPythonVersion(input.configPathAbs);
  return `py-${pythonVersion}-${configHash}`;
}

function readPythonVersion(configPathAbs: string | undefined): string {
  if (configPathAbs === undefined || configPathAbs.length === 0) return 'unknown';
  if (!existsSync(configPathAbs)) return 'unknown';
  let content: string;
  try {
    content = readFileSync(configPathAbs, 'utf8');
  } catch {
    /* v8 ignore next */
    return 'unknown';
  }
  const match = REQUIRES_PYTHON_RE.exec(content);
  return match ? sanitize(match[1] ?? 'unknown') : 'unknown';
}

function sanitize(s: string): string {
  // Keep cache-key strings shell- and filename-safe.
  return s.replaceAll(/[^A-Za-z0-9._+-]/g, '_').slice(0, 32);
}
