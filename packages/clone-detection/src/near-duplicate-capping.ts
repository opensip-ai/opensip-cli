/**
 * Component capping/partition helpers for near-duplicate clustering. Split
 * from `find-near-duplicates.ts` (file-length budget); pure functions over
 * the candidate/edge shapes.
 */

import type { CloneCandidate } from './types.js';

/** One near-duplicate candidate pair: indices into the eligible set + estimated Jaccard. */
export interface NearEdge {
  readonly a: number;
  readonly b: number;
  readonly similarity: number;
}

/** Connected components of residual near-edges after a size cap. */
export function residualConnectedComponents(
  edges: readonly NearEdge[],
): readonly { indices: Set<number>; edges: NearEdge[] }[] {
  if (edges.length === 0) return [];
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) ?? r;
    let cur = x;
    while (cur !== r) {
      const next = parent.get(cur) ?? cur;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of edges) {
    if (!parent.has(e.a)) parent.set(e.a, e.a);
    if (!parent.has(e.b)) parent.set(e.b, e.b);
    union(e.a, e.b);
  }
  const byRoot = new Map<number, { indices: Set<number>; edges: NearEdge[] }>();
  for (const e of edges) {
    const root = find(e.a);
    let bucket = byRoot.get(root);
    if (!bucket) {
      bucket = { indices: new Set(), edges: [] };
      byRoot.set(root, bucket);
    }
    bucket.indices.add(e.a);
    bucket.indices.add(e.b);
    bucket.edges.push(e);
  }
  return [...byRoot.values()];
}

/** Cap by degree (desc) then location so hubs survive the size bound. */
export function capComponentIndicesByDegree(
  eligible: readonly CloneCandidate[],
  component: readonly number[],
  edges: readonly NearEdge[],
  maxSize: number,
): number[] {
  if (component.length <= maxSize) return [...component];
  const degree = new Map<number, number>();
  for (const i of component) degree.set(i, 0);
  for (const e of edges) {
    if (degree.has(e.a)) degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    if (degree.has(e.b)) degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  return [...component]
    .sort((ai, bi) => {
      const d = (degree.get(bi) ?? 0) - (degree.get(ai) ?? 0);
      if (d !== 0) return d;
      const a = eligible[ai];
      const b = eligible[bi];
      if (!a || !b) return ai - bi;
      if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
      if (a.line !== b.line) return a.line - b.line;
      if (a.column !== b.column) return a.column - b.column;
      return compareQualifiedNames(a.qualifiedName, b.qualifiedName);
    })
    .slice(0, maxSize);
}

function compareQualifiedNames(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Stable location order, then keep at most `maxSize` member indices. */
export function capComponentIndices(
  eligible: readonly CloneCandidate[],
  component: readonly number[],
  maxSize: number,
): number[] {
  if (component.length <= maxSize) return [...component];
  return [...component]
    .sort((ai, bi) => {
      const a = eligible[ai];
      const b = eligible[bi];
      if (!a || !b) return 0;
      if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
      if (a.line !== b.line) return a.line - b.line;
      if (a.column !== b.column) return a.column - b.column;
      return compareQualifiedNames(a.qualifiedName, b.qualifiedName);
    })
    .slice(0, maxSize);
}

export function nearIndicesInComponent(edges: readonly NearEdge[]): Set<number> {
  const nearIndices = new Set<number>();
  for (const e of edges) {
    nearIndices.add(e.a);
    nearIndices.add(e.b);
  }
  return nearIndices;
}
