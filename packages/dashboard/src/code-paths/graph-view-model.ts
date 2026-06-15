/**
 * View-model projection for the Code Graph "Visualization" view.
 *
 * Projects the raw graph `GraphCatalog` (consumed by JSON shape from
 * `@opensip-cli/contracts` — never from `@opensip-cli/graph`) into
 * the slim, embed-ready `GraphViewModel` the Cytoscape renderer consumes.
 *
 * PACKAGE-LEVEL projection (item 10): the visualization renders a
 * node-link graph at *package* granularity, NOT function granularity.
 * Function-level catalogs on real repos contain thousands of function
 * nodes — unusable in a node-link layout. This projector aggregates the
 * function call graph up to packages:
 *
 *  - Node  = one package (id = label = package name via the same
 *    attribution the Coupling view uses — see `packageOf` below, which
 *    mirrors `pkgOf` in `path-utils.ts`).
 *  - Edge  = caller-package → callee-package, with `weight` = the number
 *    of underlying function→function call edges between those packages.
 *
 * This is intentionally the same package→package data the Coupling grid
 * shows — a node-link rendering of it rather than a matrix. Every OTHER
 * consumer (Coupling drilldown, Functions table, rules, …) still reads
 * the function-level catalog directly; only THIS view aggregates up.
 *
 * This module is the bundle-size budget enforcement point: the report
 * ships what this projector emits, not the catalog's storage shape.
 *
 * Architecture decisions:
 *  - Projection runs at report-generation time (server-side, in
 *    `generator.ts`) and the result is embedded as a JSON blob, mirroring
 *    the existing `graph-catalog` blob.
 *  - Cross-package cycles are detected with Tarjan's SCC over the package
 *    graph (cheap at package granularity — tens of nodes, not thousands).
 *    The engine's SCC implementation is off-limits to this package (the
 *    catalog-decoupling rule §2.4); the local replica lives in the sibling
 *    `graph-scc.ts` module.
 */

import { buildAdjacency, tarjanSccIds } from './graph-scc.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-cli/contracts';

/**
 * Slim, embed-ready projection of a graph catalog for the dashboard's
 * Visualization view. Produced by {@link projectCatalogToGraphViewModel}
 * and consumed by `view-graph.ts`.
 *
 * Aggregated to PACKAGE granularity — one node per package, one edge per
 * directed package→package coupling.
 */
export interface GraphViewModel {
  /**
   * Catalog-level language (e.g. `'typescript'`). Copied here so the view
   * doesn't need a separate handle on `graphCatalog`. The catalog is
   * single-language; this is NOT a per-node filter.
   */
  readonly language: string;

  readonly nodes: readonly GraphViewModelNode[];
  readonly edges: readonly GraphViewModelEdge[];
}

export interface GraphViewModelNode {
  /** Stable handle AND display label — the package name. */
  readonly id: string;

  /** Display label — the package name (same as {@link id}). */
  readonly label: string;

  /**
   * Total coupling degree = fan-in + fan-out call count (sum of incident
   * edge weights). Drives node *size* — hub packages render larger.
   * Pre-computed here so the renderer can size without re-iterating edges.
   */
  readonly totalCoupling: number;

  /**
   * SCC membership over the PACKAGE graph. `null` = not in a non-trivial
   * package-level cycle. Non-null = string id shared by every package in
   * the same cyclic cluster. Drives cross-package-cycle highlighting.
   */
  readonly sccId: string | null;
}

export interface GraphViewModelEdge {
  /** Source package name (caller). */
  readonly source: string;

  /** Target package name (callee). */
  readonly target: string;

  /**
   * Number of underlying function→function call edges from the source
   * package into the target package. Drives edge *thickness*.
   */
  readonly weight: number;

  /**
   * `true` iff this edge participates in a package-level cycle (both
   * endpoints in the same non-null `sccId`). Highlights cross-package
   * cycle backbones in concert with the node `sccId` grouping.
   */
  readonly isCycleEdge: boolean;
}

/** Thrown when the catalog is structurally unusable for projection. */
export class GraphViewModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphViewModelError';
  }
}

interface MutableNode {
  readonly id: string;
  totalCoupling: number;
  sccId: string | null;
}

interface MutableEdge {
  readonly source: string;
  readonly target: string;
  weight: number;
}

/**
 * Project a graph catalog into the slim, PACKAGE-LEVEL {@link GraphViewModel}.
 *
 * Pure function — no I/O, no side effects. Four passes:
 *  - Pass A: map every function `bodyHash` to its package (so call targets,
 *    which are bodyHashes, can be resolved to a package).
 *  - Pass B: walk function call edges, aggregate to package→package edges
 *    keyed by `caller→callee`, accumulating a call-count `weight`.
 *  - Pass C: derive package nodes (one per package seen) and accumulate
 *    `totalCoupling` (fan-in + fan-out weight) on each.
 *  - Pass D: Tarjan SCC over the package graph — stamp `sccId` on cyclic
 *    packages and `isCycleEdge` on edges whose endpoints share an `sccId`.
 *
 * @throws {GraphViewModelError} when `catalog` or `catalog.functions` is missing.
 */
export function projectCatalogToGraphViewModel(catalog: GraphCatalog): GraphViewModel {
  if (!catalog || typeof catalog !== 'object' || !catalog.functions) {
    throw new GraphViewModelError('catalog is missing or has no functions map');
  }

  const packageByHash = mapHashesToPackages(catalog); // Pass A
  const edgeByKey = aggregatePackageEdges(catalog, packageByHash); // Pass B
  const { nodes, edges } = deriveNodesAndEdges(packageByHash, edgeByKey); // Pass C

  // Pass D: Tarjan SCC over the package graph. Self-loops (intra-package
  // calls — the matrix diagonal) are excluded so a single package with
  // internal calls is NOT flagged as a cycle; only genuine multi-package
  // cycles (A→B→A) earn an sccId.
  const adjacency = buildAdjacency(
    nodes,
    edges.filter((e) => e.source !== e.target),
  );
  const sccByNode = tarjanSccIds(
    nodes.map((n) => n.id),
    adjacency,
  );
  for (const node of nodes) node.sccId = sccByNode.get(node.id) ?? null;

  return {
    language: catalog.language,
    nodes: nodes.map(toViewModelNode),
    edges: edges.map((e) => toViewModelEdge(e, sccByNode)),
  };
}

/**
 * The package a function occurrence belongs to. Mirrors `pkgOf` in
 * `path-utils.ts` (the browser-side helper the Coupling view uses) so the
 * server-side projection and the client-side coupling matrix attribute
 * functions to packages identically: prefer the build-time-stamped
 * `occurrence.package` (scope-stripped), else the path heuristic.
 */
export function packageOf(occ: GraphFunctionOccurrence): string {
  if (occ && typeof occ.package === 'string' && occ.package.length > 0) {
    return shortPackage(occ.package);
  }
  return packageOfPath(occ ? occ.filePath : '');
}

/** Strip an npm scope for display: "@opensip-cli/lang-typescript" → "lang-typescript". */
function shortPackage(name: string): string {
  if (typeof name !== 'string') return '<unknown>';
  return name.codePointAt(0) === 64 /* @ */ ? name.slice(name.indexOf('/') + 1) : name;
}

/** Path-only fallback (first segment under `packages/`). */
function packageOfPath(filePath: string): string {
  if (typeof filePath !== 'string' || filePath.length === 0) return '<unknown>';
  const m = /^packages\/([^/]+)\//.exec(filePath);
  return m ? m[1] : '<unknown>';
}

/** Pass A — bodyHash → package name (last write wins, mirroring buildIndexes). */
function mapHashesToPackages(catalog: GraphCatalog): Map<string, string> {
  const packageByHash = new Map<string, string>();
  for (const name of Object.keys(catalog.functions)) {
    const occs: readonly GraphFunctionOccurrence[] = catalog.functions[name] ?? [];
    for (const occ of occs) packageByHash.set(occ.bodyHash, packageOf(occ));
  }
  return packageByHash;
}

/**
 * Pass B — aggregate function call edges to directed package→package edges
 * keyed by `callercallee`, accumulating a call-count `weight`. Call
 * targets whose bodyHash is not an in-project function are dropped (matching
 * the function-level projector's handling of unresolved/external calls).
 * Self-package edges (intra-package calls) are kept — they show up as
 * self-loops, consistent with the Coupling matrix diagonal.
 */
function aggregatePackageEdges(
  catalog: GraphCatalog,
  packageByHash: ReadonlyMap<string, string>,
): Map<string, MutableEdge> {
  const edgeByKey = new Map<string, MutableEdge>();
  for (const name of Object.keys(catalog.functions)) {
    for (const occ of catalog.functions[name] ?? []) {
      accumulateOccurrenceEdges(occ, packageByHash, edgeByKey);
    }
  }
  return edgeByKey;
}

/** Add one weighted package edge per resolved call target of `occ`. */
function accumulateOccurrenceEdges(
  occ: GraphFunctionOccurrence,
  packageByHash: ReadonlyMap<string, string>,
  edgeByKey: Map<string, MutableEdge>,
): void {
  const callerPkg = packageByHash.get(occ.bodyHash);
  if (callerPkg === undefined) return;
  for (const edge of occ.calls ?? []) {
    for (const target of edge.to ?? []) {
      const calleePkg = packageByHash.get(target);
      if (calleePkg === undefined) continue; // external / unresolved
      bumpEdge(edgeByKey, callerPkg, calleePkg);
    }
  }
}

/** Increment (or create) the weighted edge for a caller-to-callee package pair. */
function bumpEdge(edgeByKey: Map<string, MutableEdge>, source: string, target: string): void {
  // Newline delimiter: package names never contain one, so caller+callee keys
  // can't collide (unlike empty-string concat).
  const key = source + '\n' + target;
  const existing = edgeByKey.get(key);
  if (existing) existing.weight += 1;
  else edgeByKey.set(key, { source, target, weight: 1 });
}

/**
 * Pass C — derive one node per package (every package that appears as a
 * function's package OR as an edge endpoint) and accumulate `totalCoupling`
 * (sum of incident edge weights) on each.
 */
function deriveNodesAndEdges(
  packageByHash: ReadonlyMap<string, string>,
  edgeByKey: ReadonlyMap<string, MutableEdge>,
): { nodes: MutableNode[]; edges: MutableEdge[] } {
  const nodeById = new Map<string, MutableNode>();
  // @fitness-ignore-next-line toctou-race-condition -- synchronous single-pass projector; `nodeById` is a local Map with no async/concurrent access, so there is no time-of-check/time-of-use window between the get and the set.
  const ensure = (id: string): MutableNode => {
    let n = nodeById.get(id);
    if (!n) {
      n = { id, totalCoupling: 0, sccId: null };
      nodeById.set(id, n);
    }
    return n;
  };
  // Every package that hosts a function is a node, even if it has no edges.
  for (const pkg of packageByHash.values()) ensure(pkg);

  const edges = [...edgeByKey.values()];
  for (const e of edges) {
    ensure(e.source).totalCoupling += e.weight;
    ensure(e.target).totalCoupling += e.weight;
  }
  return { nodes: [...nodeById.values()], edges };
}

function toViewModelNode(n: MutableNode): GraphViewModelNode {
  return { id: n.id, label: n.id, totalCoupling: n.totalCoupling, sccId: n.sccId };
}

function toViewModelEdge(
  e: MutableEdge,
  sccByNode: ReadonlyMap<string, string>,
): GraphViewModelEdge {
  const sourceScc = sccByNode.get(e.source);
  const targetScc = sccByNode.get(e.target);
  return {
    source: e.source,
    target: e.target,
    weight: e.weight,
    isCycleEdge: sourceScc != null && sourceScc === targetScc,
  };
}
