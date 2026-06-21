/**
 * Browser-side `Indexes` builder.
 *
 * The catalog persists only `functions[name][i].calls[].to[]`. v0.2's
 * O(1) `Indexes` is in-memory only; the dashboard rebuilds it on
 * panel-init time. Output: { byBodyHash, occurrencesByHash,
 * bySimpleName, callees, callers }.
 *
 * Blast radius is no longer computed here. The engine's features stage
 * (Plan C) is the single canonical home for the bounded reverse-BFS blast
 * score; this builder now only assembles the adjacency the views need for
 * navigation and member resolution.
 *
 * Also exports `resolveCalleeOcc(target, callerOcc, indexes)` — the shared
 * call-target → callee-occurrence resolver. It lives here (not in any single
 * view) because more than one view needs it: the Coupling drilldown AND the
 * function-level Visualization both resolve a call target's bodyHash to the
 * occurrence the caller can actually reach, disambiguating body-hash
 * collisions across packages.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import { pkgOf } from './path-utils.js';

import type { CatalogLike, IndexesLike, OccLike } from './code-paths-types.js';

/** Append `value` to the array bucket at `key`, creating the bucket on first use. */
function pushToBucket<V>(map: Map<string, V[]>, key: string, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

/**
 * Pass 1: populate byBodyHash (last-writer-wins per body), occurrencesByHash (all
 * occurrences per body), and bySimpleName.
 */
function indexOccurrences(
  catalog: CatalogLike,
  byBodyHash: Map<string, OccLike>,
  occurrencesByHash: Map<string, OccLike[]>,
  bySimpleName: Map<string, string[]>,
): void {
  for (const name of Object.keys(catalog.functions ?? {})) {
    for (const occ of catalog.functions?.[name] ?? []) {
      byBodyHash.set(occ.bodyHash, occ);
      pushToBucket(occurrencesByHash, occ.bodyHash, occ);
      pushToBucket(bySimpleName, name, occ.bodyHash);
    }
  }
}

/**
 * Pass 2: build callees (forward) + callers (reverse) from byBodyHash. Edges
 * resolving to a hash not in byBodyHash are dropped (unresolved/external targets).
 */
function indexEdges(
  byBodyHash: Map<string, OccLike>,
  callees: Map<string, string[]>,
  callers: Map<string, string[]>,
): void {
  for (const occ of byBodyHash.values()) {
    const out: string[] = [];
    for (const edge of occ.calls ?? []) {
      for (const target of edge.to ?? []) {
        if (!byBodyHash.has(target)) continue;
        out.push(target);
        pushToBucket(callers, target, occ.bodyHash);
      }
    }
    if (out.length > 0) callees.set(occ.bodyHash, out);
  }
}

export function buildIndexes(catalog: CatalogLike | null): IndexesLike {
  // byBodyHash keeps only one occurrence per body (last-writer-wins), collapsing
  // identical bodies across packages; occurrencesByHash preserves every
  // occurrence so coupling can attribute a callee to the correct package instead
  // of the collision winner.
  const byBodyHash = new Map<string, OccLike>();
  const occurrencesByHash = new Map<string, OccLike[]>();
  const bySimpleName = new Map<string, string[]>();
  const callees = new Map<string, string[]>();
  const callers = new Map<string, string[]>();
  if (!catalog?.functions) {
    return { byBodyHash, occurrencesByHash, bySimpleName, callees, callers };
  }
  indexOccurrences(catalog, byBodyHash, occurrencesByHash, bySimpleName);
  indexEdges(byBodyHash, callees, callers);
  return { byBodyHash, occurrencesByHash, bySimpleName, callees, callers };
}

// Resolve a call target (a bodyHash) to the callee occurrence the caller can
// reach, disambiguating body-hash collisions across packages. byBodyHash
// keeps only one occurrence per hash (the collision winner), which
// mis-attributes the callee's package; occurrencesByHash preserves all, so we
// prefer the caller's own package, else fall back deterministically (lowest
// qualifiedName). The dashboard catalog carries no import set, so this mirrors
// the engine's fast-mode (same-package-only) attribution. Used by the Coupling
// drilldown and the function-level Visualization projection.
export function resolveCalleeOcc(
  target: string,
  callerOcc: OccLike,
  indexes: IndexesLike,
): OccLike | undefined {
  const candidates = indexes.occurrencesByHash?.get(target);
  if (!candidates || candidates.length === 0) return indexes.byBodyHash.get(target);
  if (candidates.length === 1) return candidates[0];
  const callerPkg = pkgOf(callerOcc);
  let samePkg: OccLike | null = null;
  let lowest = candidates[0];
  for (const c of candidates) {
    if (!samePkg && pkgOf(c) === callerPkg) samePkg = c;
    if ((c.qualifiedName ?? '') < (lowest.qualifiedName ?? '')) lowest = c;
  }
  return samePkg ?? lowest;
}
