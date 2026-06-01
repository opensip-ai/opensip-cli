/**
 * Package-aware callee resolution.
 *
 * A call edge stores its target as a `bodyHash`, which is a CONTENT hash:
 * two functions with identical bodies in different packages share one hash.
 * Looking a callee up by hash alone therefore mis-attributes its package
 * whenever bodies collide (the cause of impossible coupling edges like
 * `core→fitness`). `resolveCallee` disambiguates such a hash to the
 * occurrence the caller can actually reach, deterministically.
 *
 * Pure, dependency-free (no node imports) so the same logic can be mirrored
 * verbatim in the dashboard's browser-side coupling view.
 */

import type { FunctionOccurrence, Indexes } from '../types.js';

const PACKAGE_RE = /^packages\/([^/]+)\//;

/**
 * The first path segment under `packages/` — the unit the coupling grid
 * groups by (so `packages/languages/lang-typescript/...` → `languages`,
 * `packages/graph/graph-typescript/...` → `graph`). Returns `'<unknown>'`
 * for paths outside `packages/`. Must match the dashboard's `packageOfPath`.
 */
export function packageOf(filePath: string): string {
  const m = PACKAGE_RE.exec(filePath);
  return m ? m[1] : '<unknown>';
}
