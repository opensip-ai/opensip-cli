// @fitness-ignore-file batch-operation-limits -- pure in-memory linear/BFS scans over the already-materialized catalog + indexes (bounded by repo size); data→data, no DB/IO/unbounded-async to batch or paginate.
/**
 * Stage 3.5 — Feature derivation.
 *
 * Pure data→data over the catalog + indexes. A *plain view* by default
 * (ADR-0006): only the columns the caller requests are computed
 * (lazy/needed-only), and the in-engine rules consume the result without it
 * ever being persisted for their sake. The dashboard columns (blast / scc /
 * packageCoupling) are materialized into the catalog JSON only when the
 * producing run requests them.
 *
 * Algorithms here are ports of analyses that first lived in dashboard-side
 * JavaScript (`code-paths/indexes.ts` blast, `code-paths/scc.ts` Tarjan,
 * `code-paths/view-coupling.ts` coupling) or inline inside individual rules
 * (the `endLine − line + 1` span, `orphan-subtree`'s reachability BFS,
 * `test-only-reachable`'s prod BFS). The engine is now the canonical home for
 * computed feature columns; dashboard helpers still assemble view-local
 * indexes and drilldowns from the catalog plus the precomputed features.
 */

import { logger } from '@opensip-tools/core';

import { occId, pkgOf, resolveCallee } from '../resolve-callee.js';
import { inferEntryPoints } from '../rules/_entry-points.js';

import type {
  BlastScore,
  Catalog,
  FeatureColumn,
  FeatureTable,
  FunctionFeatures,
  FunctionOccurrence,
  GraphConfig,
  Indexes,
  PackageEdgeFeature,
  PackageFeatures,
  PersistedFeatures,
  PersistedFunctionFeatures,
  SccFeatures,
} from '../types.js';

/**
 * Maximum BFS depth used when computing per-function blast radius. Ported
 * verbatim from the dashboard's former `code-paths/indexes.ts`: bounded depth
 * keeps cost predictable; a slight under-count for deep chains is acceptable
 * for a "what's risky to touch" heuristic.
 */
const BLAST_MAX_DEPTH = 5;

const EMPTY_FUNCTION: ReadonlyMap<string, FunctionFeatures> = new Map();
const EMPTY_PACKAGE: ReadonlyMap<string, PackageFeatures> = new Map();
const EMPTY_SCC: readonly SccFeatures[] = [];
const EMPTY_EDGE: readonly PackageEdgeFeature[] = [];

/** True when any function-grain column is requested. */
function wantsFunctionGrain(set: ReadonlySet<FeatureColumn>): boolean {
  return (
    set.has('bodyLines') ||
    set.has('blast') ||
    set.has('reachableFromEntry') ||
    set.has('reachableOnlyFromTests')
  );
}

/**
 * Compute the requested feature columns over the catalog + indexes. Only the
 * entities whose driving columns are present are populated; everything else
 * is the shared empty value. An empty `requested` ⇒ an all-empty table.
 */
export function buildFeatures(
  catalog: Catalog,
  indexes: Indexes,
  config: GraphConfig,
  requested: readonly FeatureColumn[],
): FeatureTable {
  const set = new Set<FeatureColumn>(requested);
  if (set.size === 0) {
    return { function: EMPTY_FUNCTION, package: EMPTY_PACKAGE, scc: EMPTY_SCC, edge: EMPTY_EDGE };
  }

  const fn = wantsFunctionGrain(set)
    ? buildFunctionFeatures(catalog, indexes, config, set)
    : EMPTY_FUNCTION;

  let pkg: ReadonlyMap<string, PackageFeatures> = EMPTY_PACKAGE;
  let edge: readonly PackageEdgeFeature[] = EMPTY_EDGE;
  if (set.has('packageCoupling')) {
    const coupling = computePackageCoupling(indexes);
    pkg = coupling.package;
    edge = coupling.edge;
  }

  const scc = set.has('scc') ? computeSccs(indexes) : EMPTY_SCC;

  logger.info({
    evt: 'graph.features.build.complete',
    module: 'graph:features',
    columns: [...set],
    functions: fn.size,
    packages: pkg.size,
    sccs: scc.length,
    edges: edge.length,
  });

  return { function: fn, package: pkg, scc, edge };
}

/**
 * Assemble per-function rows, attaching only the requested columns. `bodyLines`
 * is always present for the function grain (cheap + always-computable);
 * `blast` / `reachableFromEntry` / `testReachable` / `reachableOnlyFromTests`
 * ride along only when their column was requested.
 */
function buildFunctionFeatures(
  catalog: Catalog,
  indexes: Indexes,
  config: GraphConfig,
  set: ReadonlySet<FeatureColumn>,
): ReadonlyMap<string, FunctionFeatures> {
  const blast = set.has('blast') ? computeBlast(indexes) : undefined;
  const reachableFromEntry = set.has('reachableFromEntry')
    ? computeReachableFromEntry(catalog, indexes, config)
    : undefined;
  // Both `testReachable` and `reachableOnlyFromTests` ride on this request.
  const needsTestReach = set.has('reachableOnlyFromTests');
  const prodReachable = needsTestReach ? computeProdReachable(catalog, indexes) : undefined;
  const testReachable = needsTestReach ? computeTestReachable(indexes) : undefined;

  const out = new Map<string, FunctionFeatures>();
  for (const [hash, occ] of indexes.byBodyHash) {
    const row: { -readonly [K in keyof FunctionFeatures]?: FunctionFeatures[K] } = {
      bodyLines: occ.endLine - occ.line + 1,
    };
    if (blast) row.blast = blast.get(hash);
    if (reachableFromEntry) row.reachableFromEntry = reachableFromEntry.has(hash);
    if (prodReachable && testReachable) {
      // `testReachable` = "exercised by a test" — reachable from a test-file
      // function (NOT merely the negation of production-reachability, which is
      // what this used to compute and which mislabeled production-reachable
      // utilities as 'not reached by any test').
      row.testReachable = testReachable.has(hash);
      row.reachableOnlyFromTests = isReachableOnlyFromTests(hash, indexes, prodReachable);
    }
    out.set(hash, row as FunctionFeatures);
  }
  return out;
}

/**
 * The `test-only-reachable` reachability predicate, lifted verbatim: a function
 * is reachable-only-from-tests when it is NOT reachable from any production
 * entry point, HAS callers, and ALL of its callers live in test files.
 */
function isReachableOnlyFromTests(
  hash: string,
  indexes: Indexes,
  prodReachable: ReadonlySet<string>,
): boolean {
  if (prodReachable.has(hash)) return false;
  const callers = indexes.callers.get(hash) ?? [];
  if (callers.length === 0) return false;
  return callers.every((h) => indexes.byBodyHash.get(h)?.inTestFile === true);
}

// ── Blast (verbatim port of dashboard code-paths/indexes.ts) ───────

/**
 * Bounded reverse BFS over `callers`: depth-1 reaches are `direct`, depth
 * 2..BLAST_MAX_DEPTH reaches are `transitive` (set-deduplicated, per-source
 * visited set seeded with `[start, ...directSet]` so cycles short-circuit
 * without inflating counts). `score = direct + 0.5 × transitive`.
 */
function bfsBlast(start: string, callers: ReadonlyMap<string, readonly string[]>): BlastScore {
  const directCallers = callers.get(start) ?? [];
  const directSet = new Set(directCallers);
  const visited = new Set<string>([start, ...directSet]);
  const transitiveSet = new Set<string>();
  let frontier = [...directSet];
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

/** One blast score per `byBodyHash` node. */
function computeBlast(indexes: Indexes): Map<string, BlastScore> {
  const out = new Map<string, BlastScore>();
  for (const target of indexes.byBodyHash.keys()) {
    out.set(target, bfsBlast(target, indexes.callers));
  }
  return out;
}

// ── Reachability (verbatim ports of the two rule-local BFS passes) ──

/**
 * Reachable from any inferred entry point. Lifted from `orphan-subtree`'s
 * `computeReachable`: seeds = `inferEntryPoints` ∪ `config.entryPointHashes`;
 * BFS over `callees`.
 */
function computeReachableFromEntry(
  catalog: Catalog,
  indexes: Indexes,
  config: GraphConfig,
): Set<string> {
  const seeds = new Set<string>();
  for (const ep of inferEntryPoints(catalog, indexes)) seeds.add(ep.bodyHash);
  for (const h of config.entryPointHashes ?? []) seeds.add(h);
  return bfsForward(seeds, indexes);
}

/**
 * Reachable from a NON-test (production) entry point. Lifted from
 * `test-only-reachable`'s `computeProductionEntries` + `bfsReachable`: seeds =
 * `inferEntryPoints` filtered to non-test occurrences; BFS over `callees`.
 */
function computeProdReachable(catalog: Catalog, indexes: Indexes): Set<string> {
  const seeds = new Set<string>();
  for (const ep of inferEntryPoints(catalog, indexes)) {
    const occ = indexes.byBodyHash.get(ep.bodyHash);
    /* v8 ignore next */
    if (!occ) continue;
    if (occ.inTestFile) continue;
    seeds.add(ep.bodyHash);
  }
  return bfsForward(seeds, indexes);
}

/**
 * Reachable from a TEST — i.e. exercised by a test. Seeds = EVERY function
 * defined in a test file (each is a potential test entry); forward BFS over
 * `callees`. A production function in the result set is transitively called by
 * some test, so `testReachable` is true. This is the correct companion to the
 * high-blast-untested rule ("not reached by any test" ⇔ not in this set) — it
 * replaces the old `!prodReachable` definition, which conflated "unreachable
 * from production" with "tested".
 */
function computeTestReachable(indexes: Indexes): Set<string> {
  const seeds = new Set<string>();
  for (const [hash, occ] of indexes.byBodyHash) {
    if (occ.inTestFile) seeds.add(hash);
  }
  return bfsForward(seeds, indexes);
}

/** Forward BFS over the `callees` adjacency from a seed set. */
function bfsForward(seeds: ReadonlySet<string>, indexes: Indexes): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [...seeds];
  while (queue.length > 0) {
    const cur = queue.shift();
    /* v8 ignore next */
    if (cur === undefined || visited.has(cur)) continue;
    visited.add(cur);
    for (const n of indexes.callees.get(cur) ?? []) {
      if (!visited.has(n)) queue.push(n);
    }
  }
  return visited;
}

// ── Tarjan SCC over an OCCURRENCE-level graph ──────────────────────

interface TarjanFrame {
  readonly v: string;
  ai: number;
}

/**
 * The occurrence-level node graph the SCC Tarjan runs over.
 *  - `nodes` — every occurrence's occId (package-unique node identity).
 *  - `byOccId` — occId → its occurrence (for package + member resolution).
 *  - `adj` — occId → deduped neighbor occIds, each call edge's target
 *    `resolveCallee`-disambiguated to the occurrence the caller can reach.
 *
 * Keying nodes by occId (NOT bodyHash) is the whole point of this stage: a
 * CONTENT hash collapses two functions with identical bodies in different
 * packages into one node, manufacturing a false cross-package SCC (the
 * `canonicalize` phantom). occId is per-occurrence, so they stay distinct.
 * The adjacency mirrors `computePackageCoupling`'s occurrence-level
 * `resolveCallee` pass; it does NOT reuse the twin-aware `indexes.callees`
 * (ADR-0003), which is intentionally body-hash-keyed for reachability rules.
 */
interface OccGraph {
  readonly nodes: readonly string[];
  readonly byOccId: ReadonlyMap<string, FunctionOccurrence>;
  readonly adj: ReadonlyMap<string, readonly string[]>;
}

/**
 * Build the occurrence-level node graph: every occurrence is a node keyed by
 * occId; each call edge's targets are resolved via `resolveCallee` to the
 * occurrence the caller actually reaches, then mapped to that callee's occId.
 * Neighbors are deduped (a Set per node) so the Tarjan adjacency stays tight.
 */
function buildOccGraph(indexes: Indexes): OccGraph {
  const byOccId = new Map<string, FunctionOccurrence>();
  const adj = new Map<string, readonly string[]>();
  for (const occs of indexes.occurrencesByHash.values()) {
    for (const occ of occs) {
      const id = occId(occ);
      byOccId.set(id, occ);
      const neighbors = new Set<string>();
      for (const callEdge of occ.calls) {
        for (const target of callEdge.to) {
          const callee = resolveCallee(target, occ, indexes);
          if (callee) neighbors.add(occId(callee));
        }
      }
      adj.set(id, [...neighbors]);
    }
  }
  return { nodes: [...byOccId.keys()], byOccId, adj };
}

/**
 * Iterative Tarjan over the occurrence-level graph (`buildOccGraph`). Singletons
 * included by the algorithm; each component's members sorted; result ordering
 * preserved (push-on-root-close). Each component is mapped to an `SccFeatures`
 * whose members are occIds, with a stable member-derived id and
 * `crossesPackages` over the members' resolved packages. Irreducible iterative
 * Tarjan (no recursion, to survive deep call graphs) — splitting it would
 * obscure the well-known algorithm.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- iterative Tarjan, see above
function computeSccs(indexes: Indexes): SccFeatures[] {
  const graph = buildOccGraph(indexes);
  const result: SccFeatures[] = [];
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let nextIndex = 0;

  const adj = (v: string): readonly string[] => graph.adj.get(v) ?? [];

  for (const start of graph.nodes) {
    if (index.has(start)) continue;
    const work: TarjanFrame[] = [{ v: start, ai: 0 }];
    while (work.length > 0) {
      const frame = work.at(-1)!;
      const v = frame.v;
      if (frame.ai === 0) {
        index.set(v, nextIndex);
        lowlink.set(v, nextIndex);
        nextIndex++;
        stack.push(v);
        onStack.add(v);
      }
      const adjV = adj(v);
      let descended = false;
      while (frame.ai < adjV.length) {
        const w = adjV[frame.ai++];
        if (!index.has(w)) {
          work.push({ v: w, ai: 0 });
          descended = true;
          break;
        } else if (onStack.has(w)) {
          const iw = index.get(w)!;
          if (iw < lowlink.get(v)!) lowlink.set(v, iw);
        }
      }
      if (descended) continue;
      if (lowlink.get(v) === index.get(v)) {
        const members: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          members.push(w);
          if (w === v) break;
        }
        members.sort();
        result.push(toSccFeatures(members, graph.byOccId));
      }
      work.pop();
      if (work.length > 0) {
        const parent = work.at(-1)!.v;
        if (lowlink.get(v)! < lowlink.get(parent)!) {
          lowlink.set(parent, lowlink.get(v)!);
        }
      }
    }
  }
  return result;
}

/** Build an `SccFeatures` row from sorted member occIds. */
function toSccFeatures(
  members: readonly string[],
  byOccId: ReadonlyMap<string, FunctionOccurrence>,
): SccFeatures {
  const packages = new Set<string>();
  for (const id of members) {
    const occ = byOccId.get(id);
    if (occ) packages.add(pkgOf(occ));
  }
  return {
    id: `scc:${members[0] ?? ''}`,
    members,
    sccSize: members.length,
    crossesPackages: packages.size > 1,
  };
}

// ── Package coupling (port of dashboard view-coupling.ts, using the
//    engine's canonical resolveCallee instead of the browser replica) ──

/**
 * Single pass over `byBodyHash`: for each occurrence (caller), resolve every
 * call-edge target to a callee occurrence via the canonical `resolveCallee`
 * (body-hash collision disambiguation), bucket by `(callerPkg, calleePkg)`.
 * Emits the unfiltered whole-graph matrix — the dashboard's `passesFilter` is
 * a UI concern, applied client-side. Self-edges (diagonal) are kept (the
 * matrix counts them). Single pass (nested caller→edge→target loops + degree
 * rollups); a verbatim port of the dashboard's former client coupling view.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- single-pass coupling aggregation, see above
function computePackageCoupling(indexes: Indexes): {
  package: ReadonlyMap<string, PackageFeatures>;
  edge: readonly PackageEdgeFeature[];
} {
  const counts = new Map<string, Map<string, number>>();
  for (const occ of indexes.byBodyHash.values()) {
    const callerPkg = pkgOf(occ);
    for (const callEdge of occ.calls) {
      for (const target of callEdge.to) {
        const callee = resolveCallee(target, occ, indexes);
        if (!callee) continue;
        const calleePkg = pkgOf(callee);
        let row = counts.get(callerPkg);
        if (!row) {
          row = new Map<string, number>();
          counts.set(callerPkg, row);
        }
        row.set(calleePkg, (row.get(calleePkg) ?? 0) + 1);
      }
    }
  }

  // edge rows: flatten, sorted by (callerPackage, calleePackage).
  const edge: PackageEdgeFeature[] = [];
  for (const [callerPackage, row] of counts) {
    for (const [calleePackage, count] of row) {
      edge.push({ callerPackage, calleePackage, count });
    }
  }
  edge.sort((a, b) =>
    a.callerPackage === b.callerPackage
      ? a.calleePackage.localeCompare(b.calleePackage)
      : a.callerPackage.localeCompare(b.callerPackage),
  );

  // package rows: couplingOut = distinct callee packages per caller;
  // couplingIn = distinct caller packages per callee. Self-edges included
  // (the matrix diagonal), so the degrees match the matrix.
  const outDistinct = new Map<string, Set<string>>();
  const inDistinct = new Map<string, Set<string>>();
  for (const { callerPackage, calleePackage } of edge) {
    addDistinct(outDistinct, callerPackage, calleePackage);
    addDistinct(inDistinct, calleePackage, callerPackage);
  }
  const pkg = new Map<string, PackageFeatures>();
  const allPkgs = new Set<string>([...outDistinct.keys(), ...inDistinct.keys()]);
  for (const name of allPkgs) {
    pkg.set(name, {
      couplingOut: outDistinct.get(name)?.size ?? 0,
      couplingIn: inDistinct.get(name)?.size ?? 0,
    });
  }
  return { package: pkg, edge };
}

function addDistinct(map: Map<string, Set<string>>, key: string, value: string): void {
  let s = map.get(key);
  if (!s) {
    s = new Set<string>();
    map.set(key, s);
  }
  s.add(value);
}

// ── FeatureTable ↔ PersistedFeatures projection (Phase 4 consumes) ──

/**
 * Project a `FeatureTable` to the JSON-safe `PersistedFeatures`, OMITTING any
 * entity whose driving column was not requested (so an empty-request table
 * projects to `{}` and a lean default-run persists no blob). Maps → records;
 * arrays pass through.
 */
export function toPersistedFeatures(
  table: FeatureTable,
  requested: readonly FeatureColumn[],
): PersistedFeatures {
  const set = new Set<FeatureColumn>(requested);
  const out: {
    -readonly [K in keyof PersistedFeatures]?: PersistedFeatures[K];
  } = {};
  if (wantsFunctionGrain(set) && table.function.size > 0) {
    const record: Record<string, PersistedFunctionFeatures> = {};
    for (const [hash, row] of table.function) record[hash] = row;
    out.function = record;
  }
  if (set.has('packageCoupling')) {
    if (table.package.size > 0) {
      const record: Record<string, PackageFeatures> = {};
      for (const [name, row] of table.package) record[name] = row;
      out.package = record;
    }
    out.edge = table.edge;
  }
  if (set.has('scc')) out.scc = table.scc;
  return out;
}

/** True when no entity is present (or every present entity is empty). */
export function isPersistedFeaturesEmpty(persisted: PersistedFeatures): boolean {
  const hasFn = persisted.function !== undefined && Object.keys(persisted.function).length > 0;
  const hasPkg = persisted.package !== undefined && Object.keys(persisted.package).length > 0;
  const hasScc = persisted.scc !== undefined && persisted.scc.length > 0;
  const hasEdge = persisted.edge !== undefined && persisted.edge.length > 0;
  return !hasFn && !hasPkg && !hasScc && !hasEdge;
}
