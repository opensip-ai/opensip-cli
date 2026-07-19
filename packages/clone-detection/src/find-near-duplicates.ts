/**
 * Near-duplicate body detection — LSH-banded MinHash, the single implementation graph's
 * `near-duplicate-function-body` rule consumes (ADR-0064). Pure over `CloneCandidate[]`;
 * emits tool-agnostic clusters (no `Signal`). Candidate pairs exclude identical
 * `bodyHash` edges and cross-language false positives (via the pre-resolved
 * `candidate.language`).
 */

import { isEligibleKind } from './find-duplicate-bodies.js';
import {
  NEAR_DUP_LSH_BANDS,
  NEAR_DUP_SIGNATURE_K,
  estimateJaccard,
  lshBandHashes,
} from './near-duplicate-signature.js';
import { UnionFind } from './near-duplicate-union-find.js';

import type { CloneCandidate, NearDupOpts, NearDuplicateCluster, NearDuplicateResult } from './types.js';

const DEFAULT_MIN_SIMILARITY = 0.85;
const DEFAULT_MIN_BODY_SIZE = 200;
const MAX_CLUSTER_SIZE = 50;
// Pairwise-loop bound per LSH bucket: a pathological bucket (many similar
// bodies hashing together) otherwise blows up O(k^2), undermining the
// LSH+MinHash design that exists to avoid all-pairs. Oversized buckets are
// deterministically sampled (first N in eligible order) and the skip is
// surfaced as the 'lsh-bucket-cap' coverage reason — bounded, never silent.
const MAX_BUCKET_PAIRWISE = 256;

/**
 * Detect near-duplicate body clusters (Jaccard ≥ `minSimilarity`, same language, distinct
 * exact hash). Returns one cluster per connected component with ≥2 near members.
 */
export function findNearDuplicates(
  candidates: readonly CloneCandidate[],
  opts: NearDupOpts = {},
): NearDuplicateResult {
  const minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const minBodySize = opts.minBodySize ?? DEFAULT_MIN_BODY_SIZE;
  const bands = opts.lshBands ?? NEAR_DUP_LSH_BANDS;
  const rows = NEAR_DUP_SIGNATURE_K / bands;
  // bands MUST divide k evenly — otherwise `rows` is fractional and band slicing is
  // misaligned. `rows * bands === k` alone does not catch this (128/7*7 round-trips to
  // 128 in IEEE-754), so test integrality.
  if (!Number.isInteger(rows) || rows < 1) return emptyResult();

  const eligible = collectEligible(candidates, minBodySize);
  if (eligible.length < 2) return emptyResult();

  const { edges, cappedBuckets } = buildNearEdges(eligible, minSimilarity, bands, rows);
  const components = clusterComponents(eligible.length, edges);
  return {
    clusters: emitComponentClusters(eligible, components, edges),
    coverage: {
      complete: cappedBuckets === 0,
      reasons: cappedBuckets === 0 ? [] : ['lsh-bucket-cap'],
      cappedBuckets,
    },
  };
}

function emptyResult(): NearDuplicateResult {
  return { clusters: [], coverage: { complete: true, reasons: [], cappedBuckets: 0 } };
}

function collectEligible(
  candidates: readonly CloneCandidate[],
  minBodySize: number,
): CloneCandidate[] {
  const out: CloneCandidate[] = [];
  for (const occ of candidates) {
    if (!isEligibleKind(occ)) continue;
    if (occ.bodySignature?.length !== NEAR_DUP_SIGNATURE_K) continue;
    if (occ.bodySize !== undefined && occ.bodySize < minBodySize) continue;
    out.push(occ);
  }
  return out;
}

interface NearEdge {
  readonly a: number;
  readonly b: number;
  readonly similarity: number;
}

function buildNearEdges(
  eligible: readonly CloneCandidate[],
  minSimilarity: number,
  bands: number,
  rows: number,
): { edges: NearEdge[]; cappedBuckets: number } {
  const buckets = indexLshBuckets(eligible, bands, rows);
  const edges: NearEdge[] = [];
  const seenPairs = new Set<string>();
  let cappedBuckets = 0;
  for (const indices of buckets.values()) {
    // Deterministic sample (first N in eligible order) before the O(k^2) loop.
    const bounded = indices.length > MAX_BUCKET_PAIRWISE ? indices.slice(0, MAX_BUCKET_PAIRWISE) : indices;
    if (bounded !== indices) cappedBuckets += 1;
    collectBucketEdges(bounded, eligible, minSimilarity, seenPairs, edges);
  }
  return { edges, cappedBuckets };
}

function indexLshBuckets(
  eligible: readonly CloneCandidate[],
  bands: number,
  rows: number,
): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (const [i, occ] of eligible.entries()) {
    if (!occ.bodySignature) continue;
    const bandHashes = lshBandHashes(occ.bodySignature, bands, rows);
    for (const [band, bandHash] of bandHashes.entries()) {
      const key = `${String(band)}:${bandHash ?? ''}`;
      let list = buckets.get(key);
      if (!list) {
        list = [];
        buckets.set(key, list);
      }
      list.push(i);
    }
  }
  return buckets;
}

function collectBucketEdges(
  indices: readonly number[],
  eligible: readonly CloneCandidate[],
  minSimilarity: number,
  seenPairs: Set<string>,
  edges: NearEdge[],
): void {
  if (indices.length < 2) return;
  for (let i = 0; i < indices.length; i++) {
    for (let j = i + 1; j < indices.length; j++) {
      const ai = indices[i];
      const bi = indices[j];
      if (ai === undefined || bi === undefined) continue;
      const key = pairKey(ai, bi);
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const edge = tryNearEdge(ai, bi, eligible, minSimilarity);
      if (edge) edges.push(edge);
    }
  }
}

function tryNearEdge(
  ai: number,
  bi: number,
  eligible: readonly CloneCandidate[],
  minSimilarity: number,
): NearEdge | undefined {
  const a = eligible[ai];
  const b = eligible[bi];
  if (!a?.bodySignature || !b?.bodySignature) return undefined;
  if (a.bodyHash === b.bodyHash) return undefined;

  // Same-language gate. `language` is the caller-resolved equivalent of graph's
  // `languageOfFile(filePath)`; undefined on either side skips the pair (identical to
  // `languageOfFile(...) === undefined`).
  const langA = a.language;
  const langB = b.language;
  if (langA === undefined || langB === undefined || langA !== langB) return undefined;

  const similarity = estimateJaccard(a.bodySignature, b.bodySignature);
  if (similarity < minSimilarity) return undefined;
  return { a: ai, b: bi, similarity };
}

function clusterComponents(size: number, edges: readonly NearEdge[]): number[][] {
  const uf = new UnionFind(size);
  for (const e of edges) uf.union(e.a, e.b);

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < size; i++) {
    const root = uf.find(i);
    const list = byRoot.get(root) ?? [];
    list.push(i);
    byRoot.set(root, list);
  }
  return [...byRoot.values()].filter((c) => c.length >= 2);
}

function emitComponentClusters(
  eligible: readonly CloneCandidate[],
  components: readonly number[][],
  edges: readonly NearEdge[],
): NearDuplicateCluster[] {
  const edgesByComponent = indexEdgesByComponent(components, edges);
  const clusters: NearDuplicateCluster[] = [];
  for (const [index, component] of components.entries()) {
    const cluster = buildComponentCluster(
      eligible,
      component,
      edgesByComponent.get(index) ?? EMPTY_EDGES,
    );
    if (cluster) clusters.push(cluster);
  }
  return clusters;
}

const EMPTY_EDGES: readonly NearEdge[] = [];

function indexEdgesByComponent(
  components: readonly number[][],
  edges: readonly NearEdge[],
): Map<number, NearEdge[]> {
  const componentByIndex = new Map<number, number>();
  for (const [componentIndex, component] of components.entries()) {
    for (const candidateIndex of component) {
      componentByIndex.set(candidateIndex, componentIndex);
    }
  }

  const edgesByComponent = new Map<number, NearEdge[]>();
  for (const edge of edges) {
    const componentIndex = componentByIndex.get(edge.a);
    if (componentIndex === undefined) continue;
    let componentEdges = edgesByComponent.get(componentIndex);
    if (!componentEdges) {
      componentEdges = [];
      edgesByComponent.set(componentIndex, componentEdges);
    }
    componentEdges.push(edge);
  }
  return edgesByComponent;
}

function buildComponentCluster(
  eligible: readonly CloneCandidate[],
  component: readonly number[],
  componentEdges: readonly NearEdge[],
): NearDuplicateCluster | undefined {
  // Cap oversized components rather than dropping them: keep the first
  // MAX_CLUSTER_SIZE members sorted by location so the finding still surfaces.
  // After the location slice, re-derive connectivity from remaining edges so
  // we never report disconnected remnants as one cluster, and never drop a
  // component solely because the hub fell outside the location window when
  // residual edges still connect ≥2 nodes.
  const cappedIndices = capComponentIndices(eligible, component, MAX_CLUSTER_SIZE);
  const cappedIndexSet = new Set(cappedIndices);
  const cappedEdges = componentEdges.filter(
    (e) => cappedIndexSet.has(e.a) && cappedIndexSet.has(e.b),
  );

  // Prefer degree-preserving selection: if the location cap severed all edges,
  // re-cap by keeping highest-degree nodes from the original component.
  let workingEdges = cappedEdges;
  if (nearIndicesInComponent(cappedEdges).size < 2 && component.length > MAX_CLUSTER_SIZE) {
    const degreeCap = capComponentIndicesByDegree(
      eligible,
      component,
      componentEdges,
      MAX_CLUSTER_SIZE,
    );
    const degreeSet = new Set(degreeCap);
    workingEdges = componentEdges.filter((e) => degreeSet.has(e.a) && degreeSet.has(e.b));
  }

  // Re-CC residual edges so a location/degree cap that severs a bridge cannot
  // merge disconnected cliques into one finding.
  const residualComponents = residualConnectedComponents(workingEdges);
  let best: NearDuplicateCluster | undefined;
  for (const residual of residualComponents) {
    if (residual.indices.size < 2) continue;
    const residualEdges = residual.edges;
    const members = [...residual.indices]
      .map((i) => eligible[i])
      .filter((o): o is CloneCandidate => !!o);
    const cluster: NearDuplicateCluster = {
      anchor: lowestByLocation(members),
      nearMembers: members.map((m) => m.qualifiedName).sort(),
      exactMembers: exactMembersInComponent(members),
      estimatedSimilarity: maxSimilarityAmong(residualEdges),
      clusterSize: members.length,
    };
    if (
      best === undefined ||
      cluster.clusterSize > best.clusterSize ||
      (cluster.clusterSize === best.clusterSize &&
        cluster.estimatedSimilarity > best.estimatedSimilarity)
    ) {
      best = cluster;
    }
  }
  return best;
}

/** Connected components of residual near-edges after a size cap. */
function residualConnectedComponents(
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
function capComponentIndicesByDegree(
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
function capComponentIndices(
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

function nearIndicesInComponent(edges: readonly NearEdge[]): Set<number> {
  const nearIndices = new Set<number>();
  for (const e of edges) {
    nearIndices.add(e.a);
    nearIndices.add(e.b);
  }
  return nearIndices;
}

function exactMembersInComponent(members: readonly CloneCandidate[]): string[] {
  const hashCounts = new Map<string, number>();
  for (const m of members) hashCounts.set(m.bodyHash, (hashCounts.get(m.bodyHash) ?? 0) + 1);
  return members
    .filter((m) => (hashCounts.get(m.bodyHash) ?? 0) > 1)
    .map((m) => m.qualifiedName)
    .sort();
}

function maxSimilarityAmong(edges: readonly NearEdge[]): number {
  let maxSim = 0;
  for (const edge of edges) {
    if (edge.similarity > maxSim) maxSim = edge.similarity;
  }
  return maxSim;
}

function lowestByLocation(occs: readonly CloneCandidate[]): CloneCandidate {
  return occs.reduce((lo, c) => {
    if (c.filePath < lo.filePath) return c;
    if (c.filePath > lo.filePath) return lo;
    if (c.line < lo.line) return c;
    if (c.line > lo.line) return lo;
    return c.column < lo.column ? c : lo;
  });
}

function pairKey(a: number, b: number): string {
  return a < b ? `${String(a)}:${String(b)}` : `${String(b)}:${String(a)}`;
}
