/**
 * @fileoverview Strongly-connected-components (Tarjan) over the graph view
 * model's node/edge set.
 *
 * Extracted from `graph-view-model.ts` to keep that projector under the
 * file-length budget. The algorithm is purely structural — it operates on
 * string ids and an adjacency map, with no dependency on the view-model
 * shapes — so it lives as a standalone, reusable unit.
 *
 * Replicated here rather than imported from the graph engine: the
 * catalog-decoupling rule forbids `dashboard → @opensip-tools/graph`.
 */

/**
 * Build a directed adjacency map (`source id → unique target ids`) from a
 * node set and edge set. Generic over any `{ id }` node and
 * `{ source, target }` edge so it stays independent of the view-model types.
 */
export function buildAdjacency(
  nodes: readonly { readonly id: string }[],
  edges: readonly { readonly source: string; readonly target: string }[],
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    const out = adjacency.get(edge.source);
    if (out && !out.includes(edge.target)) out.push(edge.target);
  }
  return adjacency;
}

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

/**
 * Tarjan's strongly-connected-components algorithm (iterative, no recursion
 * so deep call graphs don't blow the stack). Returns a map from node id → SCC
 * id, populated ONLY for nodes in a non-trivial SCC (size ≥ 2, or a singleton
 * with a self-edge). Trivial singletons are omitted so the view treats them
 * as `sccId: null`.
 */
export function tarjanSccIds(
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
