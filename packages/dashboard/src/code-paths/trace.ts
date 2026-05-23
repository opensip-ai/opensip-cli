/**
 * BFS from inferred entry-point set to a target bodyHash.
 *
 * Entry-point heuristic mirrors v0.2's: any function in
 * `packages/cli/src/index.ts`, plus any exported function with no
 * callers in catalog. Returns the shortest path as a bodyHash[]
 * starting at an entry point and ending at the target. Returns null
 * when no entry point reaches the target.
 */

export function dashboardTraceJs(): string {
  return String.raw`
function inferEntryPointHashes(catalog, indexes) {
  const entries = [];
  if (!catalog || !catalog.functions) return entries;
  for (const occ of indexes.byBodyHash.values()) {
    const isCli = occ.filePath === 'packages/cli/src/index.ts';
    const callerList = indexes.callers.get(occ.bodyHash) || [];
    const isExportedRoot = occ.visibility === 'exported' && callerList.length === 0;
    if (isCli || isExportedRoot) entries.push(occ.bodyHash);
  }
  return entries;
}

function traceFromEntry(targetHash, catalog, indexes) {
  if (!targetHash || !indexes || !indexes.byBodyHash.has(targetHash)) return null;
  const entries = inferEntryPointHashes(catalog, indexes);
  if (entries.length === 0) return null;
  // BFS over the forward (callees) graph; record predecessors so we
  // can reconstruct the path on the first hit.
  const queue = [];
  const visited = new Set();
  const parent = new Map();
  for (const e of entries) {
    queue.push(e);
    visited.add(e);
  }
  while (queue.length > 0) {
    const v = queue.shift();
    if (v === targetHash) {
      const path = [];
      let cur = v;
      while (cur !== undefined) {
        path.unshift(cur);
        cur = parent.get(cur);
      }
      return path;
    }
    const adj = indexes.callees.get(v) || [];
    for (const w of adj) {
      if (visited.has(w)) continue;
      visited.add(w);
      parent.set(w, v);
      queue.push(w);
    }
  }
  return null;
}
`;
}
