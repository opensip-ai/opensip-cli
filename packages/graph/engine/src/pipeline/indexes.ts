/**
 * Stage 3 — Index build.
 *
 * Pure linear scans over the catalog. No TS, no AST, no filesystem.
 * Data → data.
 */

import { logger } from '@opensip-tools/core';

import type { Catalog, FunctionOccurrence, Indexes } from '../types.js';

export function buildIndexes(catalog: Catalog): Indexes {
  const byBodyHash = new Map<string, FunctionOccurrence>();
  const bySimpleName = new Map<string, string[]>();
  for (const name of Object.keys(catalog.functions)) {
    indexNameBucket(catalog, name, byBodyHash, bySimpleName);
  }
  const { callees, callers } = buildAdjacency(byBodyHash);

  logger.info({
    evt: 'graph.indexes.build.complete',
    module: 'graph:indexes',
    nodes: byBodyHash.size,
    edges: [...callees.values()].reduce((n, arr) => n + arr.length, 0),
  });

  return { byBodyHash, bySimpleName, callees, callers };
}

function indexNameBucket(
  catalog: Catalog,
  name: string,
  byBodyHash: Map<string, FunctionOccurrence>,
  bySimpleName: Map<string, string[]>,
): void {
  const occs: readonly FunctionOccurrence[] | undefined = catalog.functions[name];
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
