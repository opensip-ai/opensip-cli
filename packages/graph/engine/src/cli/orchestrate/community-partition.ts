/**
 * `community` partition strategy — Louvain over the file-level import
 * graph (ADR-0045, prototype B1).
 *
 * Pure function: no I/O, no Date.now, no Math.random. Determinism is a
 * HARD requirement (shard ids are the fragment-cache primary key), built
 * from three mandatory layers:
 *
 *   1. **No randomness.** `randomWalk: false`; a seeded local mulberry32
 *      rng is passed anyway (belt-and-braces) so no library code path can
 *      reach `Math.random`. `resolution: 1` and `fastLocalMoves: true`
 *      are pinned explicitly — defaults are not a contract.
 *   2. **Canonical iteration.** graphology iterates nodes/edges in
 *      insertion order, so nodes and edges are inserted SORTED — the
 *      output never depends on caller order.
 *   3. **Canonical output.** Louvain's numeric labels are iteration-order
 *      artifacts and are discarded; partition ids derive from each
 *      community's anchor (lexicographically smallest repo-relative POSIX
 *      member path), so ids are membership-local and never renumber
 *      globally.
 *
 * The graphology / graphology-communities-louvain dependencies are pinned
 * EXACT in package.json — iteration order is behavior; a version bump
 * must re-run the determinism suite (`__tests__/community-partition.test.ts`)
 * and the B1 measurement.
 */

import { createRequire } from 'node:module';
import { relative } from 'node:path';

import { UndirectedGraph } from 'graphology';

import { toPosixPath } from '../../cross-package/posix-path.js';

import type { SyntheticPartition } from './partition-chunk.js';
import type { DetailedLouvainOutput, LouvainOptions } from 'graphology-communities-louvain';

/**
 * graphology-communities-louvain is CJS-only (`module.exports = louvain`)
 * but its `index.d.ts` declares an ES `export default`, so under Node16
 * module resolution TypeScript mistypes the default-import binding as the
 * module namespace while Node binds it to `module.exports` (the function).
 * `createRequire` gets the real `module.exports` under guaranteed CJS
 * semantics (repo precedent: cli/src/bootstrap/register-tools.ts); the
 * narrow surface we use is typed from the package's NAMED type exports,
 * which are accurate. The exact version pin freezes this shape.
 */
const louvain = createRequire(import.meta.url)('graphology-communities-louvain') as {
  detailed(graph: UndirectedGraph, options?: LouvainOptions): DetailedLouvainOutput;
};

/** Fixed Louvain seed — NEVER derived from time/env (determinism layer 1). */
const LOUVAIN_SEED = 0x5eed;

/** Input to {@link communityPartition}. */
export interface CommunityPartitionInput {
  /** Candidate files, absolute paths. Caller order is irrelevant (canonicalized). */
  readonly files: readonly string[];
  /** Absolute repo root — files are keyed by their repo-relative POSIX path. */
  readonly repoRoot: string;
  /** Directed absolute-path edges; endpoints outside `files` are ignored. */
  readonly importEdges: ReadonlyArray<readonly [from: string, to: string]>;
  /** Max files per emitted partition (callers pass the chunkSize, 2000). */
  readonly maxShardSize: number;
}

/**
 * Partition `files` into import-graph communities (Louvain), with
 * deterministic anchor-derived ids (`community:<slug>`). Output follows
 * the `partitionFlatRepo` contract: partitions sorted by id, files within
 * each partition sorted, absolute paths. Byte-identical run-to-run for a
 * fixed `(files, importEdges)` by construction.
 */
export function communityPartition(
  input: CommunityPartitionInput,
): readonly SyntheticPartition[] {
  const keyToAbs = buildKeyMap(input.files, input.repoRoot);
  const graph = buildCanonicalGraph(keyToAbs, input.importEdges);
  const result = louvain.detailed(graph, {
    resolution: 1,
    randomWalk: false,
    rng: mulberry32(LOUVAIN_SEED),
    getEdgeWeight: 'weight',
    fastLocalMoves: true,
  });
  const communities = canonicalCommunities(result.communities);
  return emitPartitions(communities, keyToAbs);
}

/**
 * Seeded deterministic PRNG (mulberry32) — 32-bit state, floats in [0,1).
 * Local ~6-line implementation; never a dependency, never Math.random.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Map each file to its repo-relative POSIX key, preserving the absolute path. */
function buildKeyMap(files: readonly string[], repoRoot: string): ReadonlyMap<string, string> {
  const keyToAbs = new Map<string, string>();
  for (const file of files) {
    keyToAbs.set(toPosixPath(relative(repoRoot, file)), file);
  }
  return keyToAbs;
}

/**
 * Canonical graph construction (determinism layer 2): node keys inserted
 * in lexicographic order (isolated files stay as singleton nodes);
 * directed absolute-path edges normalized to keys, endpoints outside the
 * node set dropped, folded onto the undirected `(min, max)` pair with an
 * accumulated integer `weight`, then inserted sorted by `(min, max)`.
 */
function buildCanonicalGraph(
  keyToAbs: ReadonlyMap<string, string>,
  importEdges: ReadonlyArray<readonly [from: string, to: string]>,
): UndirectedGraph {
  const graph = new UndirectedGraph({ multi: false });
  const sortedKeys = [...keyToAbs.keys()].sort();
  for (const key of sortedKeys) {
    graph.addNode(key);
  }
  const weights = foldUndirectedWeights(keyToAbs, importEdges);
  const sortedPairs = [...weights.keys()].sort();
  for (const pair of sortedPairs) {
    const [a, b] = pair.split('\u0000');
    graph.addEdge(a, b, { weight: weights.get(pair) });
  }
  return graph;
}

/**
 * Fold directed absolute-path edges onto undirected key pairs, keyed by
 * `min<NUL>max` — NUL cannot appear in a file path (unlike spaces) and
 * sorts below every other character, so sorting the joined keys IS the
 * `(min, max)` tuple sort. Accumulates an integer weight per pair;
 * self-loops and edges with an endpoint outside the node set are dropped.
 */
function foldUndirectedWeights(
  keyToAbs: ReadonlyMap<string, string>,
  importEdges: ReadonlyArray<readonly [from: string, to: string]>,
): ReadonlyMap<string, number> {
  const absToKey = new Map<string, string>();
  for (const [key, abs] of keyToAbs) {
    absToKey.set(abs, key);
  }
  const weights = new Map<string, number>();
  for (const [fromAbs, toAbs] of importEdges) {
    const from = absToKey.get(fromAbs);
    const to = absToKey.get(toAbs);
    if (from === undefined || to === undefined || from === to) continue;
    const pair = from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
    weights.set(pair, (weights.get(pair) ?? 0) + 1);
  }
  return weights;
}

/**
 * Canonical relabel (determinism layer 3): group node keys by Louvain's
 * numeric label, sort each community's members, and sort communities by
 * their anchor (members[0] — the lexicographically smallest member).
 * The numeric labels never escape this function.
 */
function canonicalCommunities(
  labels: Readonly<Record<string, number>>,
): readonly (readonly string[])[] {
  const byLabel = new Map<number, string[]>();
  for (const [key, label] of Object.entries(labels)) {
    const members = byLabel.get(label);
    if (members === undefined) {
      byLabel.set(label, [key]);
    } else {
      members.push(key);
    }
  }
  const communities = [...byLabel.values()].map((members) => members.sort());
  communities.sort((a, b) => ((a[0] ?? '') < (b[0] ?? '') ? -1 : 1));
  return communities;
}

/**
 * Derive a partition id from a community's anchor: `community:<slug>`
 * where slug maps `/` and `.` to `-` (e.g. `src/api/client.ts` →
 * `community:src-api-client-ts`). Anchors are unique by construction
 * (communities are disjoint), so ids satisfy `assertUniqueShardIds`.
 */
function anchorId(anchor: string): string {
  return `community:${anchor.replaceAll(/[./]/g, '-')}`;
}

/**
 * Emit the `SyntheticPartition[]` output contract: member keys mapped
 * back to absolute paths, files sorted, partitions sorted by id.
 */
function emitPartitions(
  communities: readonly (readonly string[])[],
  keyToAbs: ReadonlyMap<string, string>,
): readonly SyntheticPartition[] {
  const out: SyntheticPartition[] = communities.map((members) => ({
    id: anchorId(members[0] ?? ''),
    files: members.map((key) => keyToAbs.get(key) ?? key).sort(),
  }));
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}
