/**
 * Stage 3 — Index build.
 *
 * Pure linear scans over the catalog. No TS, no AST, no filesystem.
 * Data → data.
 */

import { logger } from '@opensip-tools/core';

import type { BlastScore, Catalog, FunctionOccurrence, Indexes } from '../types.js';

/**
 * Maximum BFS depth used when computing per-function blast radius.
 * Bounded per design choice 2026-05-25 (graph + codeindex parity work)
 * — predictable O(N·k^d) cost, slight under-count for deep chains is
 * acceptable for a "what's risky to touch" heuristic.
 */
const BLAST_MAX_DEPTH = 5;

/** Builds query-side indexes (by-body-hash, by-simple-name, blast radius) over the catalog. */
export function buildIndexes(catalog: Catalog): Indexes {
  const byBodyHash = new Map<string, FunctionOccurrence>();
  const bySimpleName = new Map<string, string[]>();
  for (const name of Object.keys(catalog.functions)) {
    indexNameBucket(catalog, name, byBodyHash, bySimpleName);
  }
  const { callees, callers } = buildAdjacency(byBodyHash);
  const blastRadius = buildBlastRadius(byBodyHash, callers);

  logger.info({
    evt: 'graph.indexes.build.complete',
    module: 'graph:indexes',
    nodes: byBodyHash.size,
    edges: [...callees.values()].reduce((n, arr) => n + arr.length, 0),
  });

  return { byBodyHash, bySimpleName, callees, callers, blastRadius };
}

function indexNameBucket(
  catalog: Catalog,
  name: string,
  byBodyHash: Map<string, FunctionOccurrence>,
  bySimpleName: Map<string, string[]>,
): void {
  const occs: readonly FunctionOccurrence[] | undefined = catalog.functions[name];
  /* v8 ignore next */
  if (!occs) return;
  for (const o of occs) {
    byBodyHash.set(o.bodyHash, o);
    let names = bySimpleName.get(name);
    if (!names) {
      names = [];
      bySimpleName.set(name, names);
    }
    names.push(o.bodyHash);
  }
}

function buildAdjacency(
  byBodyHash: ReadonlyMap<string, FunctionOccurrence>,
): { callees: Map<string, string[]>; callers: Map<string, string[]> } {
  const callees = new Map<string, string[]>();
  const callers = new Map<string, string[]>();
  for (const occ of byBodyHash.values()) {
    const out = collectOutgoing(occ, byBodyHash, callers);
    if (out.length > 0) callees.set(occ.bodyHash, out);
  }
  return { callees, callers };
}

function collectOutgoing(
  occ: FunctionOccurrence,
  byBodyHash: ReadonlyMap<string, FunctionOccurrence>,
  callers: Map<string, string[]>,
): string[] {
  const out: string[] = [];
  for (const edge of occ.calls) {
    for (const target of edge.to) {
      /* v8 ignore next */
      if (!byBodyHash.has(target)) continue;
      out.push(target);
      pushCaller(callers, target, occ.bodyHash);
    }
  }
  return out;
}

function pushCaller(callers: Map<string, string[]>, target: string, caller: string): void {
  let inb = callers.get(target);
  if (!inb) {
    inb = [];
    callers.set(target, inb);
  }
  inb.push(caller);
}

/**
 * Compute per-function blast scores via bounded reverse BFS.
 *
 * For each function, walk the `callers` adjacency up to BLAST_MAX_DEPTH
 * hops. Depth-1 reaches are "direct"; depth-2..BLAST_MAX_DEPTH reaches
 * are "transitive" (set-deduplicated). The visited set is per-source so
 * cycles short-circuit without inflating counts.
 */
function buildBlastRadius(
  byBodyHash: ReadonlyMap<string, FunctionOccurrence>,
  callers: ReadonlyMap<string, readonly string[]>,
): Map<string, BlastScore> {
  const out = new Map<string, BlastScore>();
  for (const target of byBodyHash.keys()) {
    out.set(target, bfsBlast(target, callers));
  }
  return out;
}

function bfsBlast(
  start: string,
  callers: ReadonlyMap<string, readonly string[]>,
): BlastScore {
  const directCallers = callers.get(start) ?? [];
  const directSet = new Set<string>(directCallers);
  const visited = new Set<string>([start, ...directSet]);
  const transitiveSet = new Set<string>();
  let frontier: readonly string[] = [...directSet];
  for (let depth = 2; depth <= BLAST_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      const parents = callers.get(node) ?? [];
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
  return { direct, transitive, score: direct + 0.5 * transitive };
}
