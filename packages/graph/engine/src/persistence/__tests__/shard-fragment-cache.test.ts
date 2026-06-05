/**
 * Per-shard fragment cache (CatalogRepo) + the incremental shard-work
 * planner. A fragment is reusable only when both its cache key and files
 * fingerprint match; planShardWork partitions shards into reuse vs rebuild
 * accordingly — the incremental-parse fix's decision point.
 */


import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stampEngineVersion } from '../../cache/engine-version.js';
import { computeFilesFingerprint } from '../../cache/invalidate.js';
import { planShardWork } from '../../cli/orchestrate/shard-runner.js';
import { CatalogRepo } from '../catalog-repo.js';

import type { Shard, ShardBuildResult } from '../../cli/orchestrate/shard-model.js';
import type { GraphLanguageAdapter } from '../../lang-adapter/types.js';

function result(shardId: string, cacheKey: string, fingerprint: string): ShardBuildResult {
  return {
    shardId,
    fragment: {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'x',
      cacheKey,
      resolutionMode: 'exact',
      functions: {},
    },
    fingerprint,
    boundaryCalls: [],
    parseErrors: [],
  };
}

describe('CatalogRepo shard-fragment cache', () => {
  let datastore: DataStore;
  let repo: CatalogRepo;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    repo = new CatalogRepo(datastore);
  });

  afterEach(() => {
    datastore.close?.();
  });

  it('round-trips a fragment and validates on matching key + fingerprint', () => {
    repo.upsertShardFragment(result('pkg:a', 'key-1', 'fp-1'));
    expect(repo.loadValidShardFragment('pkg:a', 'key-1', 'fp-1')).not.toBeNull();
  });

  it('returns null on a stale fingerprint or a stale cache key', () => {
    repo.upsertShardFragment(result('pkg:a', 'key-1', 'fp-1'));
    expect(repo.loadValidShardFragment('pkg:a', 'key-1', 'fp-CHANGED')).toBeNull();
    expect(repo.loadValidShardFragment('pkg:a', 'key-CHANGED', 'fp-1')).toBeNull();
  });

  it('returns null for an unknown shard', () => {
    expect(repo.loadValidShardFragment('pkg:missing', 'k', 'f')).toBeNull();
  });

  it('upsert replaces a prior row for the same shard', () => {
    repo.upsertShardFragment(result('pkg:a', 'key-1', 'fp-1'));
    repo.upsertShardFragment(result('pkg:a', 'key-2', 'fp-2'));
    expect(repo.loadValidShardFragment('pkg:a', 'key-1', 'fp-1')).toBeNull();
    expect(repo.loadValidShardFragment('pkg:a', 'key-2', 'fp-2')).not.toBeNull();
  });

  it('prunes fragments for shards no longer present', () => {
    repo.upsertShardFragment(result('pkg:a', 'k', 'f'));
    repo.upsertShardFragment(result('pkg:b', 'k', 'f'));
    repo.pruneShardFragmentsExcept(['pkg:b']);
    expect(repo.loadValidShardFragment('pkg:a', 'k', 'f')).toBeNull();
    expect(repo.loadValidShardFragment('pkg:b', 'k', 'f')).not.toBeNull();
  });
});

describe('planShardWork', () => {
  let dir: string;
  let datastore: DataStore;
  let repo: CatalogRepo;

  // A stub adapter whose cacheKey is a stable function of its config path —
  // enough to drive the planner without a real TypeScript build.
  const adapter = {
    cacheKey: (input: { projectDirAbs: string; configPathAbs?: string; resolutionMode: string }) =>
      `key-${input.configPathAbs ?? 'none'}-${input.resolutionMode}`,
  } as unknown as GraphLanguageAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shard-plan-'));
    datastore = DataStoreFactory.open({ backend: 'memory' });
    repo = new CatalogRepo(datastore);
  });

  afterEach(() => {
    datastore.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  function shard(id: string): Shard {
    const file = join(dir, `${id}.ts`);
    writeFileSync(file, 'export const x = 1;\n', 'utf8');
    return { id, rootDir: dir, files: [file], configPathAbs: join(dir, `${id}.tsconfig`) };
  }

  it('rebuilds every shard when the cache is empty', () => {
    const shards = [shard('a'), shard('b')];
    const plan = planShardWork(shards, repo, adapter, 'exact', true);
    expect(plan.cached).toHaveLength(0);
    expect(plan.toBuild).toHaveLength(2);
  });

  it('reuses an unchanged shard and rebuilds only the changed one', () => {
    const a = shard('a');
    const b = shard('b');
    // Seed both with a fragment whose key+fingerprint match the current files.
    for (const s of [a, b]) {
      // planShardWork stamps the engine version onto the comparison key, so
      // the seeded fragment must carry the same stamp (in production the worker
      // stamps via assembleCatalog). ADR-0015.
      const key = stampEngineVersion(
        adapter.cacheKey({
          projectDirAbs: s.rootDir,
          configPathAbs: s.configPathAbs,
          resolutionMode: 'exact',
        }),
      );
      const fp = computeFilesFingerprint(s.files);
      repo.upsertShardFragment(result(s.id, key, fp));
    }
    // Change shard b's file so its fingerprint no longer matches.
    writeFileSync(b.files[0], 'export const x = 2; export const y = 3;\n', 'utf8');

    const plan = planShardWork([a, b], repo, adapter, 'exact', true);
    expect(plan.cached.map((r) => r.shardId)).toEqual(['a']);
    expect(plan.toBuild.map((s) => s.id)).toEqual(['b']);
  });

  it('rebuilds everything when useCache is false', () => {
    const plan = planShardWork([shard('a')], repo, adapter, 'exact', false);
    expect(plan.toBuild).toHaveLength(1);
  });
});
