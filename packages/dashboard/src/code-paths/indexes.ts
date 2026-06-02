/**
 * Browser-side `Indexes` builder — emitted as a JS string for the
 * inlined dashboard script. Mirrors v0.2's `pipeline/indexes.ts`
 * but ported to vanilla JS that runs in the page.
 *
 * The catalog persists only `functions[name][i].calls[].to[]`. v0.2's
 * O(1) `Indexes` is in-memory only; the dashboard rebuilds it on
 * panel-init time. Output: { byBodyHash, occurrencesByHash,
 * bySimpleName, callees, callers }.
 *
 * Blast radius is no longer computed here. The engine's features stage
 * (`pipeline/features.ts`, Plan C) is the single canonical home for the
 * bounded reverse-BFS blast score; a dashboard-bound run materializes it
 * into `catalog.features.function[bodyHash].blast` and the Hot view reads
 * it from there (falling back to the raw inbound-caller count when the
 * catalog carries no features). This builder now only assembles the
 * adjacency the views need for navigation and member resolution.
 */

export function dashboardIndexesJs(): string {
  return String.raw`
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
    return { byBodyHash, occurrencesByHash, bySimpleName, callees, callers };
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
  return { byBodyHash, occurrencesByHash, bySimpleName, callees, callers };
}
`;
}
