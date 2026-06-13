// @fitness-ignore-file batch-operation-limits -- pure in-memory linear scans over the already-materialized catalog (bounded by repo size); the for-of loops build data→data indexes, with no DB/IO/unbounded-async to batch or paginate.
/**
 * Stage 3 — Index build.
 *
 * Pure linear scans over the catalog. No TS, no AST, no filesystem.
 * Data → data.
 */

import { logger, withSpan } from '@opensip-cli/core';

import { occId, pkgOf } from '../resolve-callee.js';

import type { Catalog, FunctionOccurrence, Indexes } from '../types.js';

/** The content-keyed maps a single linear scan of the catalog produces. */
export interface HashMaps {
  readonly byBodyHash: Map<string, FunctionOccurrence>;
  readonly occurrencesByHash: Map<string, FunctionOccurrence[]>;
  readonly bySimpleName: Map<string, string[]>;
  /** `${filePath}:${line}:${column}` → occurrence (package-unique node id). */
  readonly byOccId: Map<string, FunctionOccurrence>;
}

/**
 * One linear pass over `catalog.functions` producing the content-keyed maps:
 * `byBodyHash` (last-writer-wins, content-dedup), `occurrencesByHash` (all
 * occurrences per hash — collision-preserving), `bySimpleName`, and `byOccId`
 * (per-occurrence location id — the SCC/cycle node identity). Shared by
 * `buildIndexes` and the cross-package edge-constraint pass so both derive
 * package identity from the same scan.
 */
export function buildHashMaps(catalog: Catalog): HashMaps {
  const maps: HashMaps = {
    byBodyHash: new Map<string, FunctionOccurrence>(),
    occurrencesByHash: new Map<string, FunctionOccurrence[]>(),
    bySimpleName: new Map<string, string[]>(),
    byOccId: new Map<string, FunctionOccurrence>(),
  };
  for (const name of Object.keys(catalog.functions)) {
    indexNameBucket(catalog, name, maps);
  }
  return maps;
}

/** Builds query-side indexes (by-body-hash, by-occ-id, by-simple-name, adjacency) over the catalog. */
export function buildIndexes(catalog: Catalog): Indexes {
  return withSpan(
    'opensip-cli-graph',
    'graph.indexes',
    () => {
      const { byBodyHash, occurrencesByHash, bySimpleName, byOccId } = buildHashMaps(catalog);
      const { callees, callers } = buildAdjacency(occurrencesByHash, byBodyHash);
      const importedPackagesByFile = buildImportedPackagesByFile(occurrencesByHash, byBodyHash);

      logger.info({
        evt: 'graph.indexes.build.complete',
        module: 'graph:indexes',
        nodes: byBodyHash.size,
        edges: [...callees.values()].reduce((n, arr) => n + arr.length, 0),
      });

      return {
        byBodyHash,
        byOccId,
        occurrencesByHash,
        importedPackagesByFile,
        bySimpleName,
        callees,
        callers,
      };
    },
    { 'graph.indexes.nodes': /* approximate */ 0 }, // can be set post in caller if needed
  );
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

function indexNameBucket(catalog: Catalog, name: string, maps: HashMaps): void {
  const occs: readonly FunctionOccurrence[] | undefined = catalog.functions[name];
  /* v8 ignore next */
  if (!occs) return;
  for (const o of occs) {
    maps.byBodyHash.set(o.bodyHash, o);
    pushTo(maps.occurrencesByHash, o.bodyHash, o);
    pushTo(maps.bySimpleName, name, o.bodyHash);
    maps.byOccId.set(occId(o), o);
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
