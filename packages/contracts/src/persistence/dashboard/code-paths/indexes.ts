/**
 * Browser-side `Indexes` builder — emitted as a JS string for the
 * inlined dashboard script. Mirrors v0.2's `pipeline/indexes.ts`
 * but ported to vanilla JS that runs in the page.
 *
 * The catalog persists only `functions[name][i].calls[].to[]`. v0.2's
 * O(1) `Indexes` is in-memory only; the dashboard rebuilds it on
 * panel-init time. Output: { byBodyHash, bySimpleName, callees, callers }.
 */

export function dashboardIndexesJs(): string {
  return String.raw`
function buildIndexes(catalog) {
  const byBodyHash = new Map();
  const bySimpleName = new Map();
  const callees = new Map();
  const callers = new Map();
  if (!catalog || !catalog.functions) {
    return { byBodyHash, bySimpleName, callees, callers };
  }
  // Pass 1: byBodyHash + bySimpleName.
  for (const name of Object.keys(catalog.functions)) {
    const occs = catalog.functions[name] || [];
    for (const occ of occs) {
      byBodyHash.set(occ.bodyHash, occ);
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
  return { byBodyHash, bySimpleName, callees, callers };
}
`;
}
