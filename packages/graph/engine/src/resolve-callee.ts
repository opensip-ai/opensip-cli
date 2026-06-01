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

import type { FunctionOccurrence, Indexes } from './types.js';

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

/** The package groups the caller's module imports (empty in fast mode). */
export function callerImportedPackages(
  callerOcc: FunctionOccurrence,
  indexes: Indexes,
): ReadonlySet<string> {
  return indexes.importedPackagesByFile.get(callerOcc.filePath) ?? EMPTY_SET;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * Resolve a call edge's target `bodyHash` to the callee occurrence the
 * caller can actually reach, disambiguating body-hash collisions across
 * packages. Order:
 *   1. an occurrence in the caller's own package;
 *   2. an occurrence in a package the caller's module imports;
 *   3. deterministic fallback — lowest `qualifiedName`.
 * Returns `undefined` when the hash has no occurrences.
 */
export function resolveCallee(
  targetHash: string,
  callerOcc: FunctionOccurrence,
  indexes: Indexes,
): FunctionOccurrence | undefined {
  const candidates = indexes.occurrencesByHash.get(targetHash);
  if (!candidates || candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const callerPkg = packageOf(callerOcc.filePath);
  const samePackage = candidates.filter((c) => packageOf(c.filePath) === callerPkg);
  if (samePackage.length > 0) return lowestByQualifiedName(samePackage);

  const imported = callerImportedPackages(callerOcc, indexes);
  if (imported.size > 0) {
    const inImported = candidates.filter((c) => imported.has(packageOf(c.filePath)));
    if (inImported.length > 0) return lowestByQualifiedName(inImported);
  }

  return lowestByQualifiedName(candidates);
}

function lowestByQualifiedName(
  occs: readonly FunctionOccurrence[],
): FunctionOccurrence {
  return occs.reduce((lo, c) => (c.qualifiedName < lo.qualifiedName ? c : lo));
}
