/**
 * BFS from inferred entry-point set to a target bodyHash.
 *
 * Entry-point heuristic mirrors v0.2's: any function in
 * `packages/cli/src/index.ts`, plus any exported function with no
 * callers in catalog. Returns the shortest path as a bodyHash[]
 * starting at an entry point and ending at the target. Returns null
 * when no entry point reaches the target.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import type { CatalogLike, IndexesLike } from './code-paths-types.js';

export function inferEntryPointHashes(catalog: CatalogLike | null, indexes: IndexesLike): string[] {
  const entries: string[] = [];
  if (!catalog?.functions) return entries;
  // @fitness-ignore-next-line batch-operation-limits -- fully synchronous in-memory Map scan (no await / promises); the heuristic mis-flags the Map iteration + .get() inside the loop.
  for (const occ of indexes.byBodyHash.values()) {
    const isCli = occ.filePath === 'packages/cli/src/index.ts';
    const callerList = indexes.callers.get(occ.bodyHash) ?? [];
    const isExportedRoot = occ.visibility === 'exported' && callerList.length === 0;
    if (isCli || isExportedRoot) entries.push(occ.bodyHash);
  }
  return entries;
}

export function traceFromEntry(
  targetHash: string,
  catalog: CatalogLike | null,
  indexes: IndexesLike,
): string[] | null {
  if (!targetHash || !indexes?.byBodyHash.has(targetHash)) return null;
  const entries = inferEntryPointHashes(catalog, indexes);
  if (entries.length === 0) return null;
  // BFS over the forward (callees) graph; record predecessors so we
  // can reconstruct the path on the first hit.
  const queue: string[] = [];
  const visited = new Set<string>();
  const parent = new Map<string, string>();
  for (const e of entries) {
    queue.push(e);
    visited.add(e);
  }
  while (queue.length > 0) {
    const v = queue.shift()!;
    if (v === targetHash) {
      const path: string[] = [];
      let cur: string | undefined = v;
      while (cur !== undefined) {
        path.unshift(cur);
        cur = parent.get(cur);
      }
      return path;
    }
    const adj = indexes.callees.get(v) ?? [];
    for (const w of adj) {
      if (visited.has(w)) continue;
      visited.add(w);
      parent.set(w, v);
      queue.push(w);
    }
  }
  return null;
}
