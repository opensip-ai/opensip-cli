/**
 * BFS from inferred entry-point set to a target bodyHash.
 *
 * Phase P0 stub: returns null. Phase P9 implements the BFS + entry-point
 * heuristic (any function in `packages/cli/src/index.ts`, or any function
 * with no callers AND `visibility === 'exported'`).
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
  // Phase P9 fills in BFS shortest-path. Phase P0 returns null.
  return null;
}
`;
}
