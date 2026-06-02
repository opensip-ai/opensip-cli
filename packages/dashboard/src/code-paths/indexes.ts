/**
 * Browser-side `Indexes` builder — emitted as a JS string for the
 * inlined dashboard script. Mirrors v0.2's `pipeline/indexes.ts`
 * but ported to vanilla JS that runs in the page.
 *
 * The catalog persists only `functions[name][i].calls[].to[]`. v0.2's
 * O(1) `Indexes` is in-memory only; the dashboard rebuilds it on
 * panel-init time. Output: { byBodyHash, occurrencesByHash,
 * bySimpleName, callees, callers, blastRadius }.
 *
 * `blastRadius` (bodyHash → { direct, transitive, score }) is a pure
 * function of the `callers` adjacency this builder already produces. The
 * engine no longer computes blast (it was only ever read by the now-deleted
 * `graph:high-blast-function` rule); blast lives here as a dashboard-only
 * insight that the Hot Functions view ranks by. It is exposed as a lazy
 * getter so the bounded reverse BFS over every node only runs the first
 * time a consumer (the Hot view on panel init) reads it — not on every
 * `buildIndexes` call.
 */

/**
 * Maximum BFS depth used when computing per-function blast radius.
 * Ported verbatim from the engine's former `pipeline/indexes.ts`:
 * bounded depth keeps cost predictable; a slight under-count for deep
 * chains is acceptable for a "what's risky to touch" heuristic.
 */
const BLAST_MAX_DEPTH = 5;

export function dashboardIndexesJs(): string {
  return String.raw`
// Per-function blast scores via bounded reverse BFS over the callers
// adjacency. For each function, walk callers up to BLAST_MAX_DEPTH hops:
// depth-1 reaches are "direct", depth-2..BLAST_MAX_DEPTH reaches are
// "transitive" (set-deduplicated). The visited set is per-source so cycles
// short-circuit without inflating counts. score = direct + 0.5 * transitive.
// Ported verbatim from the engine's former pipeline/indexes.ts.
var BLAST_MAX_DEPTH = ${String(BLAST_MAX_DEPTH)};
function bfsBlast(start, callers) {
  const directCallers = callers.get(start) || [];
  const directSet = new Set(directCallers);
  const visited = new Set([start, ...directSet]);
  const transitiveSet = new Set();
  let frontier = [...directSet];
  for (let depth = 2; depth <= BLAST_MAX_DEPTH && frontier.length > 0; depth++) {
    const next = [];
    for (const node of frontier) {
      const parents = callers.get(node) || [];
      for (const parent of parents) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        transitiveSet.add(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  const direct = directSet.size;
  const transitive = transitiveSet.size;
  return { direct: direct, transitive: transitive, score: direct + 0.5 * transitive };
}
function buildBlastRadius(byBodyHash, callers) {
  const out = new Map();
  for (const target of byBodyHash.keys()) {
    out.set(target, bfsBlast(target, callers));
  }
  return out;
}
function buildIndexes(catalog) {
  const byBodyHash = new Map();
  // All occurrences per body. byBodyHash keeps only one (last-writer-wins),
  // collapsing identical bodies across packages; occurrencesByHash preserves
  // every occurrence so coupling can attribute a callee to the correct
  // package instead of the collision winner.
  const occurrencesByHash = new Map();
  const bySimpleName = new Map();
  const callees = new Map();
  const callers = new Map();
  if (!catalog || !catalog.functions) {
    return withLazyBlast({ byBodyHash, occurrencesByHash, bySimpleName, callees, callers });
  }
  // Pass 1: byBodyHash + occurrencesByHash + bySimpleName.
  for (const name of Object.keys(catalog.functions)) {
    const occs = catalog.functions[name] || [];
    for (const occ of occs) {
      byBodyHash.set(occ.bodyHash, occ);
      let all = occurrencesByHash.get(occ.bodyHash);
      if (!all) { all = []; occurrencesByHash.set(occ.bodyHash, all); }
      all.push(occ);
      let bucket = bySimpleName.get(name);
      if (!bucket) { bucket = []; bySimpleName.set(name, bucket); }
      bucket.push(occ.bodyHash);
    }
  }
  // Pass 2: callees (forward) + callers (reverse). Edges that resolve
  // to a hash not in byBodyHash are dropped; this mirrors v0.2's
  // behavior for unresolved/external targets.
  for (const occ of byBodyHash.values()) {
    const out = [];
    for (const edge of (occ.calls || [])) {
      for (const target of (edge.to || [])) {
        if (!byBodyHash.has(target)) continue;
        out.push(target);
        let inb = callers.get(target);
        if (!inb) { inb = []; callers.set(target, inb); }
        inb.push(occ.bodyHash);
      }
    }
    if (out.length > 0) callees.set(occ.bodyHash, out);
  }
  return withLazyBlast({ byBodyHash, occurrencesByHash, bySimpleName, callees, callers });
}
// Expose blastRadius as a lazy getter: the bounded reverse BFS over every
// node only runs the first time it's read (the Hot view on panel init),
// then memoizes. Keeps buildIndexes itself cheap for views that never need it.
function withLazyBlast(indexes) {
  let cached = null;
  Object.defineProperty(indexes, 'blastRadius', {
    enumerable: true,
    configurable: true,
    get() {
      if (cached === null) cached = buildBlastRadius(indexes.byBodyHash, indexes.callers);
      return cached;
    },
  });
  return indexes;
}
`;
}
