/**
 * Determinism suite for the `community` partition strategy (ADR-0045).
 * Ships WITH the partitioner — the ADR's enforcement clause names this
 * file. Byte-identity means `JSON.stringify` equality, not `toEqual`;
 * input shuffling uses a SEEDED shuffle (mulberry32 — `Math.random` in a
 * determinism test would be self-defeating).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeFilesFingerprint } from '../../../cache/invalidate.js';
import { communityPartition } from '../community-partition.js';
import { partitionFlatRepo } from '../flat-monorepo-strategy.js';

const REPO_ROOT = '/repo';

/** Seeded PRNG (mulberry32) for the shuffle tests — never Math.random. */
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

/** Seeded Fisher–Yates shuffle (returns a copy; input untouched). */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    out[i] = out[j];
    out[j] = a;
  }
  return out;
}

interface ClusteredInput {
  readonly files: readonly string[];
  readonly importEdges: readonly (readonly [string, string])[];
  readonly clusters: readonly (readonly string[])[];
  readonly isolated: readonly string[];
}

/**
 * ~120 synthetic file paths across 4 planted clusters with dense
 * intra-cluster + sparse cross-cluster edges, plus isolated files.
 * Directory prefixes deliberately do NOT align with clusters (files
 * rotate through src/lib/app), so directory-based strategies cannot
 * trivially recover the structure — Louvain must.
 */
function buildClusteredInput(): ClusteredInput {
  const dirs = ['src', 'lib', 'app'];
  const files: string[] = [];
  const clusters: string[][] = [];
  for (let c = 0; c < 4; c++) {
    const members: string[] = [];
    for (let i = 0; i < 26; i++) {
      const dir = dirs[(c + i) % dirs.length] ?? 'src';
      const file = `${REPO_ROOT}/${dir}/c${String(c)}-f${String(i).padStart(2, '0')}.ts`;
      members.push(file);
      files.push(file);
    }
    clusters.push(members);
  }
  const isolated: string[] = [];
  for (let i = 0; i < 10; i++) {
    const file = `${REPO_ROOT}/misc/iso-${String(i)}.ts`;
    isolated.push(file);
    files.push(file);
  }
  const importEdges: (readonly [string, string])[] = [];
  for (const members of clusters) {
    for (let i = 0; i < members.length; i++) {
      const from = members[i];
      importEdges.push(
        [from, members[(i + 1) % members.length]],
        [from, members[(i + 3) % members.length]],
        [from, members[(i + 7) % members.length]],
      );
    }
  }
  // Sparse cross-cluster edges (one per adjacent cluster pair).
  for (let c = 0; c < 3; c++) {
    const a = clusters[c] as readonly string[];
    const b = clusters[c + 1] as readonly string[];
    importEdges.push([a[c], b[c]]);
  }
  return { files, importEdges, clusters, isolated };
}

describe('communityPartition determinism', () => {
  const input = buildClusteredInput();
  const run = () =>
    communityPartition({
      files: input.files,
      repoRoot: REPO_ROOT,
      importEdges: input.importEdges,
      maxShardSize: 2000,
    });

  it('is byte-identical across repeated runs (JSON.stringify equality)', () => {
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it('is invariant under seeded shuffling of files AND importEdges', () => {
    const baseline = JSON.stringify(run());
    for (const seed of [1, 42, 0xde_ad]) {
      const shuffled = communityPartition({
        files: seededShuffle(input.files, seed),
        repoRoot: REPO_ROOT,
        importEdges: seededShuffle(input.importEdges, seed + 1),
        maxShardSize: 2000,
      });
      expect(JSON.stringify(shuffled)).toBe(baseline);
    }
  });

  it('is total and disjoint: union of partition files === input set, no overlap', () => {
    const partitions = run();
    const seen = new Set<string>();
    for (const partition of partitions) {
      for (const file of partition.files) {
        expect(seen.has(file)).toBe(false);
        seen.add(file);
      }
    }
    expect([...seen].sort()).toEqual([...input.files].sort());
  });

  it('emits unique partition ids (feeds assertUniqueShardIds)', () => {
    const ids = run().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('recovers the 4 planted clusters into at most 6 partitions (sanity, not tuning)', () => {
    const partitions = run();
    const clusterFiles = new Set(input.clusters.flat());
    const touched = new Set<string>();
    for (const partition of partitions) {
      if (partition.files.some((f) => clusterFiles.has(f))) touched.add(partition.id);
    }
    expect(touched.size).toBeLessThanOrEqual(6);
  });

  it('pools isolated files into community-pool-N partitions', () => {
    const partitions = run();
    const pools = partitions.filter((p) => p.id.startsWith('community-pool-'));
    expect(pools.length).toBeGreaterThanOrEqual(1);
    const pooled = new Set(pools.flatMap((p) => [...p.files]));
    for (const file of input.isolated) {
      expect(pooled.has(file)).toBe(true);
    }
  });

  it('emits partitions sorted by id with files sorted within each', () => {
    const partitions = run();
    const ids = partitions.map((p) => p.id);
    expect(ids).toEqual([...ids].sort());
    for (const partition of partitions) {
      expect([...partition.files]).toEqual([...partition.files].sort());
    }
  });
});

describe('communityPartition guard rails', () => {
  it('splits an oversized community into community:<slug>.chunk-N partitions of ≤ maxShardSize', () => {
    // One 70-file CLIQUE (a ring would legitimately be cut into several
    // sub-30 communities by Louvain — a clique cannot be), maxShardSize
    // 30 → chunks 30/30/10; the sub-minimum 10-file tail chunk is then
    // pooled (rail 2 runs after rail 1).
    const files: string[] = [];
    for (let i = 0; i < 70; i++) {
      files.push(`${REPO_ROOT}/one/f${String(i).padStart(2, '0')}.ts`);
    }
    const importEdges: (readonly [string, string])[] = [];
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        importEdges.push([files[i], files[j]]);
      }
    }
    const partitions = communityPartition({
      files,
      repoRoot: REPO_ROOT,
      importEdges,
      maxShardSize: 30,
    });

    for (const partition of partitions) {
      expect(partition.files.length).toBeLessThanOrEqual(30);
    }
    const chunkIds = partitions.filter((p) => /^community:.+\.chunk-\d+$/.test(p.id));
    expect(chunkIds.length).toBe(2);
    const pools = partitions.filter((p) => p.id.startsWith('community-pool-'));
    expect(pools.length).toBe(1);
    expect(pools[0]?.files.length).toBe(10);
    expect(new Set(partitions.map((p) => p.id)).size).toBe(partitions.length);
  });

  it('pools an all-tiny input into a single pool (sole pool may stay under the minimum)', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((f) => `${REPO_ROOT}/${f}`);
    const partitions = communityPartition({
      files,
      repoRoot: REPO_ROOT,
      importEdges: [],
      maxShardSize: 2000,
    });
    expect(partitions.length).toBe(1);
    expect(partitions[0]?.id).toBe('community-pool-0');
    expect([...(partitions[0]?.files ?? [])].sort()).toEqual([...files].sort());
  });

  it('packs pooled files into multiple pools when they exceed maxShardSize', () => {
    const files: string[] = [];
    for (let i = 0; i < 30; i++) {
      files.push(`${REPO_ROOT}/iso/f${String(i).padStart(2, '0')}.ts`);
    }
    const partitions = communityPartition({
      files,
      repoRoot: REPO_ROOT,
      importEdges: [],
      maxShardSize: 20,
    });
    const ids = partitions.map((p) => p.id);
    expect(ids).toEqual(['community-pool-0', 'community-pool-1']);
    for (const partition of partitions) {
      expect(partition.files.length).toBeLessThanOrEqual(20);
    }
  });
});

describe('partitionFlatRepo community dispatch', () => {
  it("fails loud: strategy 'community' without importEdges throws ConfigurationError", () => {
    expect(() =>
      partitionFlatRepo({
        files: [`${REPO_ROOT}/a.ts`],
        repoRoot: REPO_ROOT,
        strategy: 'community',
      }),
    ).toThrow(ConfigurationError);
  });

  it('dispatches to the community partitioner with chunkSize as maxShardSize', () => {
    const files = ['a.ts', 'b.ts', 'c.ts'].map((f) => `${REPO_ROOT}/${f}`);
    const partitions = partitionFlatRepo({
      files,
      repoRoot: REPO_ROOT,
      strategy: 'community',
      importEdges: [
        [`${REPO_ROOT}/a.ts`, `${REPO_ROOT}/b.ts`],
        [`${REPO_ROOT}/b.ts`, `${REPO_ROOT}/c.ts`],
      ],
    });
    expect(partitions.length).toBeGreaterThanOrEqual(1);
    expect(partitions.flatMap((p) => [...p.files]).sort()).toEqual([...files].sort());
  });
});

describe('cold==warm at the shard level (on-disk fixture)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'community-partition-warm-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('an unchanged tree yields identical shard ids AND identical files-fingerprints per id', () => {
    // ~30 REAL files so computeFilesFingerprint can stat them: two
    // 15-file clusters; chunkSize 20 forces two pools (15+15 > 20).
    const clusterA: string[] = [];
    const clusterB: string[] = [];
    mkdirSync(join(dir, 'a'), { recursive: true });
    mkdirSync(join(dir, 'b'), { recursive: true });
    for (let i = 0; i < 15; i++) {
      const fileA = join(dir, 'a', `a${String(i).padStart(2, '0')}.ts`);
      const fileB = join(dir, 'b', `b${String(i).padStart(2, '0')}.ts`);
      writeFileSync(fileA, `export const a${String(i)} = ${String(i)};\n`, 'utf8');
      writeFileSync(fileB, `export const b${String(i)} = ${String(i)};\n`, 'utf8');
      clusterA.push(fileA);
      clusterB.push(fileB);
    }
    const files = [...clusterA, ...clusterB];
    const importEdges: (readonly [string, string])[] = [];
    for (const cluster of [clusterA, clusterB]) {
      for (let i = 0; i < cluster.length; i++) {
        importEdges.push([cluster[i], cluster[(i + 1) % cluster.length]]);
      }
    }
    const partitionOnce = () =>
      partitionFlatRepo({
        files,
        repoRoot: dir,
        strategy: 'community',
        importEdges,
        chunkSize: 20,
      });

    const cold = partitionOnce();
    const warm = partitionOnce();

    // Same Shard-id mapping resolveSyntheticFlatShards applies.
    const coldIds = cold.map((p) => `partition:${p.id}`);
    const warmIds = warm.map((p) => `partition:${p.id}`);
    expect(warmIds).toEqual(coldIds);
    expect(cold.length).toBeGreaterThanOrEqual(2);

    // Identical membership fingerprint per shard id — a second
    // planShardWork over the unchanged tree would be 100% cache hits.
    const fingerprintsById = new Map(
      cold.map((p) => [`partition:${p.id}`, computeFilesFingerprint(p.files)]),
    );
    for (const partition of warm) {
      expect(computeFilesFingerprint(partition.files)).toBe(
        fingerprintsById.get(`partition:${partition.id}`),
      );
    }
  });
});
