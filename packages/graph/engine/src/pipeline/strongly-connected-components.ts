/**
 * Iterative Tarjan strongly-connected components (graph-internal).
 * Shared by occurrence SCC features and package-cycle queries.
 */

import { compareCodePointStrings } from '../code-point-order.js';

interface TarjanFrame {
  readonly v: string;
  readonly adjacent: readonly string[];
  ai: number;
}

interface TarjanState {
  readonly result: string[][];
  readonly index: Map<string, number>;
  readonly lowlink: Map<string, number>;
  readonly onStack: Set<string>;
  readonly stack: string[];
  nextIndex: number;
}

function createFrame(node: string, neighbors: (v: string) => readonly string[]): TarjanFrame {
  return { v: node, adjacent: neighbors(node), ai: 0 };
}

function discover(v: string, state: TarjanState): void {
  state.index.set(v, state.nextIndex);
  state.lowlink.set(v, state.nextIndex);
  state.nextIndex++;
  state.stack.push(v);
  state.onStack.add(v);
}

function popComponent(root: string, state: TarjanState): void {
  const members: string[] = [];
  for (;;) {
    const member = state.stack.pop();
    if (member === undefined) break;
    state.onStack.delete(member);
    members.push(member);
    if (member === root) break;
  }
  members.sort(compareCodePointStrings);
  state.result.push(members);
}

function updateParentLowlink(
  child: string,
  work: readonly TarjanFrame[],
  state: TarjanState,
): void {
  const parent = work.at(-1)?.v;
  if (parent === undefined) return;
  const childLow = state.lowlink.get(child);
  const parentLow = state.lowlink.get(parent);
  if (childLow !== undefined && parentLow !== undefined && childLow < parentLow) {
    state.lowlink.set(parent, childLow);
  }
}

function updateBackEdgeLowlink(v: string, next: string, state: TarjanState): void {
  if (!state.onStack.has(next)) return;
  const nextIndex = state.index.get(next);
  const currentLow = state.lowlink.get(v);
  if (nextIndex !== undefined && currentLow !== undefined && nextIndex < currentLow) {
    state.lowlink.set(v, nextIndex);
  }
}

function advanceFrame(
  frame: TarjanFrame,
  nodeSet: ReadonlySet<string>,
  neighbors: (v: string) => readonly string[],
  work: TarjanFrame[],
  state: TarjanState,
): boolean {
  const next = frame.adjacent[frame.ai++];
  if (next === undefined || !nodeSet.has(next)) return false;
  if (state.index.has(next)) {
    updateBackEdgeLowlink(frame.v, next, state);
  } else {
    work.push(createFrame(next, neighbors));
  }
  return true;
}

function visitRoot(
  start: string,
  nodeSet: ReadonlySet<string>,
  neighbors: (v: string) => readonly string[],
  state: TarjanState,
): void {
  const work: TarjanFrame[] = [createFrame(start, neighbors)];
  while (work.length > 0) {
    const frame = work.at(-1);
    if (frame === undefined) break;
    const v = frame.v;
    if (!state.index.has(v)) discover(v, state);

    if (advanceFrame(frame, nodeSet, neighbors, work, state)) continue;
    if (frame.ai <= frame.adjacent.length) continue;

    if (state.lowlink.get(v) === state.index.get(v)) popComponent(v, state);
    work.pop();
    updateParentLowlink(v, work, state);
  }
}

/**
 * Compute SCCs over `nodes` with `neighbors(v)`. Deterministic: components'
 * members are sorted; input node order is preserved for discovery order.
 * Stack-safe iterative Tarjan; O(V+E).
 */
export function stronglyConnectedComponents(
  nodes: readonly string[],
  neighbors: (v: string) => readonly string[],
): readonly (readonly string[])[] {
  const uniqueNodes = [...new Set(nodes)];
  const nodeSet = new Set(uniqueNodes);
  const state: TarjanState = {
    result: [],
    index: new Map(),
    lowlink: new Map(),
    onStack: new Set(),
    stack: [],
    nextIndex: 0,
  };

  for (const start of uniqueNodes) {
    if (!state.index.has(start)) visitRoot(start, nodeSet, neighbors, state);
  }
  state.result.sort((a, b) => compareCodePointStrings(a[0] ?? '', b[0] ?? ''));
  return state.result;
}
