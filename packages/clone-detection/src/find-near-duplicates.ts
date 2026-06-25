// @fitness-ignore-file batch-operation-limits -- pure in-memory synchronous scans over the already-materialized candidate list (LSH buckets, candidate pairs, union-find components), bounded by input size; data→data, no async/IO/DB to batch or paginate.
/**
 * Near-duplicate body detection — LSH-banded MinHash, the single implementation graph's
 * `near-duplicate-function-body` rule consumes (ADR-0064). Pure over `CloneCandidate[]`;
 * emits tool-agnostic clusters (no `Signal`). Candidate pairs exclude identical
 * `bodyHash` edges and cross-language false positives (via the pre-resolved
 * `candidate.language`).
 */

import { NEAR_DUP_LSH_BANDS, NEAR_DUP_SIGNATURE_K } from './near-duplicate-signature.js';
import { estimateJaccard, lshBandHashes } from './near-duplicate-signature.js';
import { isEligibleKind } from './find-duplicate-bodies.js';

import type { CloneCandidate, NearDupOpts, NearDuplicateCluster } from './types.js';

const DEFAULT_MIN_SIMILARITY = 0.85;
const DEFAULT_MIN_BODY_SIZE = 200;
const MAX_CLUSTER_SIZE = 50;

/**
 * Detect near-duplicate body clusters (Jaccard ≥ `minSimilarity`, same language, distinct
 * exact hash). Returns one cluster per connected component with ≥2 near members.
 */
export function findNearDuplicates(
  candidates: readonly CloneCandidate[],
  opts: NearDupOpts = {},
): NearDuplicateCluster[] {
  const minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const minBodySize = opts.minBodySize ?? DEFAULT_MIN_BODY_SIZE;
  const bands = opts.lshBands ?? NEAR_DUP_LSH_BANDS;
  const rows = NEAR_DUP_SIGNATURE_K / bands;
  // bands MUST divide k evenly — otherwise `rows` is fractional and band slicing is
  // misaligned. `rows * bands === k` alone does not catch this (128/7*7 round-trips to
  // 128 in IEEE-754), so test integrality.
  if (!Number.isInteger(rows) || rows < 1) return [];

  const eligible = collectEligible(candidates, minBodySize);
  if (eligible.length < 2) return [];

  const edges = buildNearEdges(eligible, minSimilarity, bands, rows);
  const components = clusterComponents(eligible.length, edges);
  return emitComponentClusters(eligible, components, edges);
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
): NearEdge[] {
  const buckets = indexLshBuckets(eligible, bands, rows);
  const edges: NearEdge[] = [];
  const seenPairs = new Set<string>();
  for (const indices of buckets.values()) {
    collectBucketEdges(indices, eligible, minSimilarity, seenPairs, edges);
  }
  return edges;
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
      const list = buckets.get(key) ?? [];
      list.push(i);
      buckets.set(key, list);
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
  const edgeByPair = buildEdgeSimilarityIndex(edges);
  const clusters: NearDuplicateCluster[] = [];
  for (const component of components) {
    const cluster = buildComponentCluster(eligible, component, edges, edgeByPair);
    if (cluster) clusters.push(cluster);
  }
  return clusters;
}

function buildEdgeSimilarityIndex(edges: readonly NearEdge[]): Map<string, number> {
  const edgeByPair = new Map<string, number>();
  for (const e of edges) {
    const key = pairKey(e.a, e.b);
    const prev = edgeByPair.get(key);
    if (prev === undefined || e.similarity > prev) edgeByPair.set(key, e.similarity);
  }
  return edgeByPair;
}

function buildComponentCluster(
  eligible: readonly CloneCandidate[],
  component: readonly number[],
  edges: readonly NearEdge[],
  edgeByPair: ReadonlyMap<string, number>,
): NearDuplicateCluster | undefined {
  const nearIndices = nearIndicesInComponent(component, edges);
  if (nearIndices.size < 2) return undefined;
  if (component.length > MAX_CLUSTER_SIZE) return undefined;

  const members = component.map((i) => eligible[i]).filter((o): o is CloneCandidate => !!o);
  const anchor = lowestByLocation(members);
  const nearMembers = [...nearIndices]
    .map((i) => eligible[i]?.qualifiedName)
    .filter((n): n is string => n !== undefined)
    .sort();
  const exactMembers = exactMembersInComponent(members);
  const maxSim = maxSimilarityAmong(nearIndices, edgeByPair);

  return {
    anchor,
    nearMembers,
    exactMembers,
    estimatedSimilarity: maxSim,
    clusterSize: component.length,
  };
}

function nearIndicesInComponent(
  component: readonly number[],
  edges: readonly NearEdge[],
): Set<number> {
  const nearIndices = new Set<number>();
  const componentSet = new Set(component);
  for (const e of edges) {
    if (!componentSet.has(e.a) && !componentSet.has(e.b)) continue;
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

function maxSimilarityAmong(
  nearIndices: ReadonlySet<number>,
  edgeByPair: ReadonlyMap<string, number>,
): number {
  let maxSim = 0;
  for (const i of nearIndices) {
    for (const j of nearIndices) {
      if (i >= j) continue;
      const sim = edgeByPair.get(pairKey(i, j));
      if (sim !== undefined && sim > maxSim) maxSim = sim;
    }
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

class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = Array.from({ length: size }, () => 0);
  }

  find(x: number): number {
    const p = this.parent[x];
    if (p === undefined || p === x) return x;
    const root = this.find(p);
    this.parent[x] = root;
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank[ra] ?? 0;
    const rankB = this.rank[rb] ?? 0;
    if (rankA < rankB) {
      this.parent[ra] = rb;
    } else if (rankA > rankB) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra] = rankA + 1;
    }
  }
}
