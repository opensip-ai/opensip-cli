/**
 * View-model projection for the Code Paths "Graph" view.
 *
 * Projects the raw graph `GraphCatalog` (consumed by JSON shape from
 * `@opensip-tools/contracts` — never from `@opensip-tools/graph`) into
 * the slim, embed-ready `GraphViewModel` the Cytoscape renderer consumes.
 *
 * This module is the bundle-size budget enforcement point: the report
 * ships what this projector emits, not the catalog's storage shape.
 * Fields the renderer never reads (function bodies, params, decorators,
 * source ranges, hashes beyond the node id) are dropped here.
 *
 * Architecture decisions (Phase 0 of docs/plans/ready/graph-visualizer-view):
 *  - Projection runs at report-generation time (server-side, in
 *    `generator.ts`) and the result is embedded as a JSON blob, mirroring
 *    the existing `graph-catalog` blob. This keeps the centrality-based
 *    truncation off the client and makes the embedded JSON size — not the
 *    raw catalog size — the measured budget.
 *  - Tarjan's SCC algorithm is replicated locally (~40 LOC) because the
 *    graph engine's implementation is off-limits to this package (the
 *    catalog-decoupling rule §2.4); the dashboard depends only on
 *    `@opensip-tools/contracts` for types, not on the engine runtime.
 *  - For catalogs above `DEFAULT_MAX_INLINE_NODES` (5,000), the projector
 *    emits only the top-N nodes by `callDegreeIn + callDegreeOut` and
 *    records the pre-truncation total in `truncatedFromTotal` so the view
 *    can banner "Showing top N of M". (Phase 0 §4.5 performance pre-filter.)
 */

import type {
  GraphCallConfidence,
  GraphCallResolution,
  GraphCatalog,
  GraphFunctionKind,
  GraphFunctionOccurrence,
  GraphVisibility,
} from '@opensip-tools/contracts';

/** Default soft cap on inlined nodes. Above this the projector truncates
 *  by call degree. Parameterizable via {@link ProjectOptions.maxInlineNodes}. */
export const DEFAULT_MAX_INLINE_NODES = 5000;

/**
 * Slim, embed-ready projection of a graph catalog for the dashboard's
 * Graph view. Produced by {@link projectCatalogToGraphViewModel} and
 * consumed by `view-graph.ts`.
 *
 * Every field has a concrete UI consumer in the skeleton / filter+search /
 * impact phases — see the plan's §4.3 field-to-consumer map.
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

  /**
   * Set when the projector truncated the catalog (performance pre-filter).
   * Holds the pre-truncation node count so the view can render a
   * "Showing top N of M" banner. `undefined` (omitted) when no truncation
   * occurred — the renderer must treat absence and `nodes.length`
   * equality with the catalog as equivalent.
   */
  readonly truncatedFromTotal?: number;
}

export interface GraphViewModelNode {
  /**
   * Stable handle — the function's `bodyHash` from the catalog. Matches
   * the key in `graphIndexes.byBodyHash`, `.callees`, and `.callers`. The
   * impact-highlight BFS keys on this.
   */
  readonly id: string;

  /**
   * Display label — the function's `qualifiedName`. The renderer truncates
   * for the canvas; the full name is available on hover. Chosen over
   * `simpleName` because graphs without qualification collapse method
   * overloads and name-collisions into unreadable multi-node hubs.
   */
  readonly label: string;

  /**
   * File the function is defined in. Required for the "open in editor"
   * affordance (matches the `editor-link.ts` pattern used by the other
   * Code Paths views).
   */
  readonly filePath: string;

  /** Drives node *shape* (e.g. diamond=constructor, square=method, circle=function-declaration). */
  readonly kind: GraphFunctionKind;

  /** Drives node *stroke style* (e.g. dashed=private, solid=exported). */
  readonly visibility: GraphVisibility;

  /** Test-file flag. Lets the view dim test nodes on demand. */
  readonly inTestFile: boolean;

  /**
   * Pre-computed in-degree (caller count). Drives node *size* — hub
   * functions render larger. Pre-computing in the projector (not on the
   * client) means the renderer can size without iterating edges first.
   */
  readonly callDegreeIn: number;

  /** Pre-computed out-degree (callee count). Same sizing rationale. */
  readonly callDegreeOut: number;

  /**
   * SCC membership. `null` = not in a non-trivial cycle. Non-null = string
   * id shared by every node in the same SCC. Drives cycle-cluster *color
   * grouping*. Pairs with {@link GraphViewModelEdge.isCycleEdge}.
   */
  readonly sccId: string | null;
}

export interface GraphViewModelEdge {
  /** Source node id (caller's bodyHash). */
  readonly source: string;

  /** Target node id (callee's bodyHash). */
  readonly target: string;

  /** Drives edge *style* (solid=static, dashed=method-dispatch, dotted=dynamic-string). */
  readonly resolution: GraphCallResolution;

  /** Drives edge *opacity* (low=faded). Surfaces parser uncertainty visually. */
  readonly confidence: GraphCallConfidence;

  /**
   * `true` iff this edge participates in a cycle (both endpoints in the
   * same non-null `sccId`). Highlights cycle backbones in concert with
   * the node `sccId` grouping.
   */
  readonly isCycleEdge: boolean;
}

export interface ProjectOptions {
  /** Soft cap on inlined nodes. Defaults to {@link DEFAULT_MAX_INLINE_NODES}. */
  readonly maxInlineNodes?: number;
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
  readonly label: string;
  readonly filePath: string;
  readonly kind: GraphFunctionKind;
  readonly visibility: GraphVisibility;
  readonly inTestFile: boolean;
  callDegreeIn: number;
  callDegreeOut: number;
  sccId: string | null;
}

interface RawEdge {
  readonly source: string;
  readonly target: string;
  readonly resolution: GraphCallResolution;
  readonly confidence: GraphCallConfidence;
}

/**
 * Project a graph catalog into the slim {@link GraphViewModel}.
 *
 * Pure function — no I/O, no side effects. Three passes:
 *  - Pass A: emit one node per function occurrence.
 *  - Pass B: emit edges (dropping targets not present as nodes, matching
 *    `buildIndexes`' behavior for unresolved/external calls) and
 *    accumulate `callDegreeIn`/`callDegreeOut` on the endpoints.
 *  - Pass C: Tarjan SCC pass — stamp `sccId` on cyclic nodes and
 *    `isCycleEdge` on edges whose endpoints share a non-null `sccId`.
 *
 * @throws {GraphViewModelError} when `catalog` or `catalog.functions` is missing.
 */
export function projectCatalogToGraphViewModel(
  catalog: GraphCatalog,
  options: ProjectOptions = {},
): GraphViewModel {
  if (!catalog || typeof catalog !== 'object' || !catalog.functions) {
    throw new GraphViewModelError('catalog is missing or has no functions map');
  }
  const maxInlineNodes = options.maxInlineNodes ?? DEFAULT_MAX_INLINE_NODES;

  const nodeById = collectNodes(catalog); // Pass A
  const rawEdges = collectEdges(catalog, nodeById); // Pass B (mutates degrees)
  const { nodes, edges, truncatedFromTotal } = applyPerformancePreFilter(
    nodeById,
    rawEdges,
    maxInlineNodes,
  );

  // Pass C: Tarjan SCC over the (possibly truncated) node/edge set.
  const adjacency = buildAdjacency(nodes, edges);
  const sccByNode = tarjanSccIds(
    nodes.map(n => n.id),
    adjacency,
  );
  for (const node of nodes) node.sccId = sccByNode.get(node.id) ?? null;

  return {
    language: catalog.language,
    nodes: nodes.map(toViewModelNode),
    edges: edges.map(e => toViewModelEdge(e, sccByNode)),
    ...(truncatedFromTotal === undefined ? {} : { truncatedFromTotal }),
  };
}

/** Pass A — one mutable node per function occurrence, keyed by `bodyHash`. */
function collectNodes(catalog: GraphCatalog): Map<string, MutableNode> {
  const nodeById = new Map<string, MutableNode>();
  for (const name of Object.keys(catalog.functions)) {
    const occs: readonly GraphFunctionOccurrence[] = catalog.functions[name] ?? [];
    for (const occ of occs) {
      // bodyHash is the stable id; a collision would mean two occurrences
      // claim the same node — last write wins (mirrors buildIndexes).
      nodeById.set(occ.bodyHash, {
        id: occ.bodyHash,
        label: occ.qualifiedName,
        filePath: occ.filePath,
        kind: occ.kind,
        visibility: occ.visibility,
        inTestFile: occ.inTestFile,
        callDegreeIn: 0,
        callDegreeOut: 0,
        sccId: null,
      });
    }
  }
  return nodeById;
}

/**
 * Pass B — emit edges (dropping targets absent from `nodeById`, matching
 * `buildIndexes`' handling of unresolved/external calls) and accumulate
 * `callDegreeIn`/`callDegreeOut` on the endpoints (mutates `nodeById`).
 */
function collectEdges(
  catalog: GraphCatalog,
  nodeById: Map<string, MutableNode>,
): RawEdge[] {
  const rawEdges: RawEdge[] = [];
  for (const name of Object.keys(catalog.functions)) {
    const occs: readonly GraphFunctionOccurrence[] = catalog.functions[name] ?? [];
    for (const occ of occs) {
      collectEdgesForOccurrence(occ, nodeById, rawEdges);
    }
  }
  return rawEdges;
}

/** Emit one {@link RawEdge} per resolved in-project call target of `occ`,
 *  accumulating degree on both endpoints. */
function collectEdgesForOccurrence(
  occ: GraphFunctionOccurrence,
  nodeById: Map<string, MutableNode>,
  out: RawEdge[],
): void {
  const sourceNode = nodeById.get(occ.bodyHash);
  if (!sourceNode) return;
  for (const edge of occ.calls ?? []) {
    for (const target of edge.to ?? []) {
      const targetNode = nodeById.get(target);
      if (!targetNode) continue;
      sourceNode.callDegreeOut += 1;
      targetNode.callDegreeIn += 1;
      out.push({
        source: occ.bodyHash,
        target,
        resolution: edge.resolution,
        confidence: edge.confidence,
      });
    }
  }
}

interface PreFilterResult {
  readonly nodes: MutableNode[];
  readonly edges: RawEdge[];
  readonly truncatedFromTotal: number | undefined;
}

/**
 * For catalogs above `maxInlineNodes`, keep the top-N nodes by total call
 * degree (centrality proxy) and drop edges with a pruned endpoint. Below
 * the cap, pass everything through untruncated.
 */
function applyPerformancePreFilter(
  nodeById: ReadonlyMap<string, MutableNode>,
  rawEdges: readonly RawEdge[],
  maxInlineNodes: number,
): PreFilterResult {
  const allNodes = [...nodeById.values()];
  if (allNodes.length <= maxInlineNodes) {
    return { nodes: allNodes, edges: [...rawEdges], truncatedFromTotal: undefined };
  }
  const kept = [...allNodes]
    .sort((a, b) => b.callDegreeIn + b.callDegreeOut - (a.callDegreeIn + a.callDegreeOut))
    .slice(0, maxInlineNodes);
  const keptIds = new Set(kept.map(n => n.id));
  return {
    nodes: kept,
    edges: rawEdges.filter(e => keptIds.has(e.source) && keptIds.has(e.target)),
    truncatedFromTotal: allNodes.length,
  };
}

function toViewModelNode(n: MutableNode): GraphViewModelNode {
  return {
    id: n.id,
    label: n.label,
    filePath: n.filePath,
    kind: n.kind,
    visibility: n.visibility,
    inTestFile: n.inTestFile,
    callDegreeIn: n.callDegreeIn,
    callDegreeOut: n.callDegreeOut,
    sccId: n.sccId,
  };
}

function toViewModelEdge(e: RawEdge, sccByNode: ReadonlyMap<string, string>): GraphViewModelEdge {
  const sourceScc = sccByNode.get(e.source);
  const targetScc = sccByNode.get(e.target);
  return {
    source: e.source,
    target: e.target,
    resolution: e.resolution,
    confidence: e.confidence,
    isCycleEdge: sourceScc != null && sourceScc === targetScc,
  };
}

/** Build a forward-adjacency map (source id → unique target ids). */
function buildAdjacency(
  nodes: readonly MutableNode[],
  edges: readonly RawEdge[],
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    const out = adjacency.get(edge.source);
    if (out && !out.includes(edge.target)) out.push(edge.target);
  }
  return adjacency;
}

/**
 * Tarjan's strongly-connected-components algorithm (iterative, no
 * recursion so deep call graphs don't blow the stack). Returns a map from
 * node id → SCC id, populated ONLY for nodes in a non-trivial SCC
 * (size ≥ 2, or a singleton with a self-edge). Trivial singletons are
 * omitted so the view treats them as `sccId: null`.
 *
 * Replicated here rather than imported from the graph engine — the
 * catalog-decoupling rule forbids `dashboard → @opensip-tools/graph`.
 */
interface TarjanState {
  readonly index: Map<string, number>;
  readonly lowlink: Map<string, number>;
  readonly onStack: Set<string>;
  readonly stack: string[];
  readonly components: string[][];
  nextIndex: number;
}

interface TarjanFrame {
  readonly v: string;
  ai: number;
}

function tarjanSccIds(
  nodeIds: readonly string[],
  adjacency: ReadonlyMap<string, string[]>,
): Map<string, string> {
  const state: TarjanState = {
    index: new Map(),
    lowlink: new Map(),
    onStack: new Set(),
    stack: [],
    components: [],
    nextIndex: 0,
  };

  for (const start of nodeIds) {
    if (state.index.has(start)) continue;
    const work: TarjanFrame[] = [{ v: start, ai: 0 }];
    while (work.length > 0) {
      stepTarjanFrame(work, state, adjacency);
    }
  }

  return assignSccIds(state.components, adjacency);
}

/**
 * Advance the top Tarjan work-frame by one DFS step: visit the node on
 * first touch, descend into the next unvisited successor, or — when the
 * frame is exhausted — close out its SCC root and propagate lowlink to the
 * parent frame before popping.
 */
function stepTarjanFrame(
  work: TarjanFrame[],
  state: TarjanState,
  adjacency: ReadonlyMap<string, string[]>,
): void {
  const frame = work.at(-1)!;
  const v = frame.v;
  if (frame.ai === 0) {
    state.index.set(v, state.nextIndex);
    state.lowlink.set(v, state.nextIndex);
    state.nextIndex += 1;
    state.stack.push(v);
    state.onStack.add(v);
  }
  const descendInto = scanSuccessors(frame, state, adjacency);
  if (descendInto !== null) {
    work.push({ v: descendInto, ai: 0 });
    return; // descend
  }
  if (state.lowlink.get(v) === state.index.get(v)) popComponent(v, state);
  work.pop();
  const parent = work.length > 0 ? work.at(-1)!.v : null;
  if (parent !== null && state.lowlink.get(v)! < state.lowlink.get(parent)!) {
    state.lowlink.set(parent, state.lowlink.get(v)!);
  }
}

/**
 * Scan the frame's remaining successors, updating lowlink for already-
 * visited on-stack nodes. Returns the first unvisited successor to descend
 * into (leaving `frame.ai` pointing past it), or `null` when exhausted.
 */
function scanSuccessors(
  frame: TarjanFrame,
  state: TarjanState,
  adjacency: ReadonlyMap<string, string[]>,
): string | null {
  const v = frame.v;
  const adj = adjacency.get(v) ?? [];
  while (frame.ai < adj.length) {
    const w = adj[frame.ai];
    frame.ai += 1;
    if (!state.index.has(w)) return w;
    if (state.onStack.has(w)) {
      const iw = state.index.get(w)!;
      if (iw < state.lowlink.get(v)!) state.lowlink.set(v, iw);
    }
  }
  return null;
}

/** Pop the stack down to SCC root `v`, recording the component. */
function popComponent(v: string, state: TarjanState): void {
  const component: string[] = [];
  for (;;) {
    const w = state.stack.pop()!;
    state.onStack.delete(w);
    component.push(w);
    if (w === v) break;
  }
  state.components.push(component);
}

/**
 * Assign a stable sccId per non-trivial component. A singleton counts as
 * cyclic only when it has a self-edge; trivial singletons are omitted so
 * the view treats them as `sccId: null`.
 */
function assignSccIds(
  components: readonly string[][],
  adjacency: ReadonlyMap<string, string[]>,
): Map<string, string> {
  const sccByNode = new Map<string, string>();
  for (const component of components) {
    const isCyclic =
      component.length >= 2 ||
      (component.length === 1 && (adjacency.get(component[0]) ?? []).includes(component[0]));
    if (!isCyclic) continue;
    // Deterministic id: smallest member id (components are not pre-sorted).
    const sccId = `scc:${[...component].sort()[0]}`;
    for (const member of component) sccByNode.set(member, sccId);
  }
  return sccByNode;
}
