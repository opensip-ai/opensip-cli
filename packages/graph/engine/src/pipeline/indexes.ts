/**
 * Stage 3 — Index build.
 *
 * Pure linear scans over the catalog. No TS, no AST, no filesystem.
 * Data → data.
 */

import { logger } from '@opensip-tools/core';

import { pkgOf } from '../resolve-callee.js';

import type { BlastScore, Catalog, FunctionOccurrence, Indexes } from '../types.js';

/**
 * Maximum BFS depth used when computing per-function blast radius.
 * Bounded per design choice 2026-05-25 (graph + codeindex parity work)
 * — predictable O(N·k^d) cost, slight under-count for deep chains is
 * acceptable for a "what's risky to touch" heuristic.
 */
const BLAST_MAX_DEPTH = 5;

/** The three content-keyed maps a single linear scan of the catalog produces. */
export interface HashMaps {
  readonly byBodyHash: Map<string, FunctionOccurrence>;
  readonly occurrencesByHash: Map<string, FunctionOccurrence[]>;
  readonly bySimpleName: Map<string, string[]>;
}

/**
 * One linear pass over `catalog.functions` producing the content-keyed maps:
 * `byBodyHash` (last-writer-wins, content-dedup), `occurrencesByHash` (all
 * occurrences per hash — collision-preserving), and `bySimpleName`. Shared by
 * `buildIndexes` and the cross-package edge-constraint pass so both derive
 * package identity from the same scan.
 */
export function buildHashMaps(catalog: Catalog): HashMaps {
  const byBodyHash = new Map<string, FunctionOccurrence>();
  const occurrencesByHash = new Map<string, FunctionOccurrence[]>();
  const bySimpleName = new Map<string, string[]>();
  for (const name of Object.keys(catalog.functions)) {
    indexNameBucket(catalog, name, byBodyHash, occurrencesByHash, bySimpleName);
  }
  return { byBodyHash, occurrencesByHash, bySimpleName };
}

/** Builds query-side indexes (by-body-hash, by-simple-name, blast radius) over the catalog. */
export function buildIndexes(catalog: Catalog): Indexes {
  const { byBodyHash, occurrencesByHash, bySimpleName } = buildHashMaps(catalog);
  const { callees, callers } = buildAdjacency(occurrencesByHash, byBodyHash);
  const blastRadius = buildBlastRadius(byBodyHash, callers);
  const importedPackagesByFile = buildImportedPackagesByFile(occurrencesByHash, byBodyHash);

  logger.info({
    evt: 'graph.indexes.build.complete',
    module: 'graph:indexes',
    nodes: byBodyHash.size,
    edges: [...callees.values()].reduce((n, arr) => n + arr.length, 0),
  });

  return { byBodyHash, occurrencesByHash, importedPackagesByFile, bySimpleName, callees, callers, blastRadius };
}

/**
 * filePath → set of package groups it imports. Reads each file's module-init
 * `dependencies[]` (the resolved import targets) and maps each to its
 * package via `packageOf`. Files without resolved imports (and all files in
 * `fast` mode, which has no `dependencies[]`) get no entry.
 */
function buildImportedPackagesByFile(
  occurrencesByHash: ReadonlyMap<string, readonly FunctionOccurrence[]>,
  byBodyHash: ReadonlyMap<string, FunctionOccurrence>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const occs of occurrencesByHash.values()) {
    for (const occ of occs) {
      const pkgs = importedPackagesOf(occ, byBodyHash);
      if (pkgs.size > 0) unionInto(out, occ.filePath, pkgs);
    }
  }
  return out;
}

/** Package groups one module-init occurrence imports (resolved via byBodyHash). */
function importedPackagesOf(
  occ: FunctionOccurrence,
  byBodyHash: ReadonlyMap<string, FunctionOccurrence>,
): Set<string> {
  const set = new Set<string>();
  for (const dep of occ.dependencies ?? []) {
    for (const targetHash of dep.to) {
      const target = byBodyHash.get(targetHash);
      if (target) set.add(pkgOf(target));
    }
  }
  return set;
}

function unionInto(map: Map<string, Set<string>>, key: string, values: ReadonlySet<string>): void {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  for (const v of values) set.add(v);
}

function indexNameBucket(
  catalog: Catalog,
  name: string,
  byBodyHash: Map<string, FunctionOccurrence>,
  occurrencesByHash: Map<string, FunctionOccurrence[]>,
  bySimpleName: Map<string, string[]>,
): void {
  const occs: readonly FunctionOccurrence[] | undefined = catalog.functions[name];
  /* v8 ignore next */
  if (!occs) return;
  for (const o of occs) {
    byBodyHash.set(o.bodyHash, o);
    pushTo(occurrencesByHash, o.bodyHash, o);
    pushTo(bySimpleName, name, o.bodyHash);
  }
}

/** Append `value` to the array stored at `key`, creating it if absent. */
function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  arr.push(value);
}

/**
 * Build the callees/callers adjacency, **twin-aware** (ADR-0003): a body hash's
 * out-edges are the UNION of every occurrence sharing that hash, deduplicated to
 * distinct neighbors. Iterating `byBodyHash` winners instead (last-writer-wins)
 * would erase losing body-twins' out-edges from the graph — which made
 * reachability rules (`orphan-subtree`, `test-only-reachable`) report false
 * orphans for any function reached only through a twin that lost the slot.
 */
function buildAdjacency(
  occurrencesByHash: ReadonlyMap<string, readonly FunctionOccurrence[]>,
  byBodyHash: ReadonlyMap<string, FunctionOccurrence>,
): { callees: Map<string, string[]>; callers: Map<string, string[]> } {
  const callees = new Map<string, string[]>();
  const callerSets = new Map<string, Set<string>>();
  for (const [ownerHash, occs] of occurrencesByHash) {
    const out = collectOutgoing(occs, byBodyHash);
    if (out.size === 0) continue;
    callees.set(ownerHash, [...out]);
    for (const target of out) pushCaller(callerSets, target, ownerHash);
  }
  const callers = new Map<string, string[]>();
  for (const [target, owners] of callerSets) callers.set(target, [...owners]);
  return { callees, callers };
}

/** Distinct in-catalog call targets across every occurrence sharing a body hash. */
function collectOutgoing(
  occs: readonly FunctionOccurrence[],
  byBodyHash: ReadonlyMap<string, FunctionOccurrence>,
): Set<string> {
  const out = new Set<string>();
  for (const occ of occs) {
    for (const edge of occ.calls) {
      for (const target of edge.to) {
        /* v8 ignore next */
        if (!byBodyHash.has(target)) continue;
        out.add(target);
      }
    }
  }
  return out;
}

function pushCaller(callers: Map<string, Set<string>>, target: string, caller: string): void {
  let inb = callers.get(target);
  if (!inb) {
    inb = new Set<string>();
    callers.set(target, inb);
  }
  inb.add(caller);
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
