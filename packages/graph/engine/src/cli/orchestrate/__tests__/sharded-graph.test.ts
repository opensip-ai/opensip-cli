/**
 * Sharded build pipeline (`runShardedGraph`) — the unified top-level
 * orchestration: plan → run shards in parallel → merge + recover
 * cross-package edges → persist (optional) → derive indexes + run rules.
 *
 * Drives real shard-worker child processes via a fixture "CLI" script
 * (same approach as shard-runner-spawn) so the whole pipeline runs
 * without a TypeScript build. Two shards each contribute one occurrence;
 * the assertions check the unified catalog, derived indexes, rule
 * signals, cache-hit flag, and failed-shard attribution.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stampEngineVersion } from '../../../cache/engine-version.js';
import { CatalogRepo } from '../../../persistence/catalog-repo.js';
import { runShardedGraph } from '../sharded-graph.js';

import type { GraphLanguageAdapter } from '../../../lang-adapter/types.js';
import type { Catalog, Indexes, Rule } from '../../../types.js';
import type { Shard } from '../shard-model.js';

// Fixture worker: emits one exported function occurrence per shard, named
// after the shard id, so the merged catalog has a predictable shape. A
// shard id starting with 'fail:' exits non-zero.
// The real worker stamps the engine version + `mode=sharded` onto the fragment
// cacheKey via assembleCatalog (ADR-0015 / ADR-0031); the fixture must emit the
// same stamped key so a no-change rerun is a clean cache hit.
const STAMPED_KEY = stampEngineVersion('key-none', 'sharded');
const WORKER_SCRIPT = String.raw`
const { readFileSync } = require('node:fs');
const spec = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const id = spec.shard.id;
if (id.startsWith('fail:')) { process.stderr.write('boom\n'); process.exit(2); }
const name = id.replace(/[^a-zA-Z0-9]/g, '_');
const occ = {
  bodyHash: 'h-' + id, simpleName: name, qualifiedName: id + '.' + name,
  filePath: id + '/index.ts', line: 1, column: 0, endLine: 1,
  kind: 'function-declaration', params: [], returnType: null,
  enclosingClass: null, decorators: [], visibility: 'exported',
  inTestFile: false, definedInGenerated: false, calls: [],
};
// Echo back the validity keys the planner computes so a no-change rerun
// is a clean cache hit: cacheKey mirrors adapter.cacheKey (configPathAbs
// is undefined here → 'key-none'); the fingerprint is computed over the
// shard's own file list exactly as planShardWork does.
const { statSync } = require('node:fs');
const files = spec.shard.files;
const parts = [String(files.length)];
for (const f of files) {
  try { const st = statSync(f); parts.push(f + '|' + String(st.mtimeMs) + '|' + String(st.size)); }
  catch { parts.push(f + '|missing'); }
}
const result = {
  shardId: id,
  fragment: {
    version: '3.0', tool: 'graph', language: 'typescript', builtAt: 'x',
    cacheKey: ${JSON.stringify(STAMPED_KEY)}, resolutionMode: 'exact', functions: { [name]: [occ] },
  },
  fingerprint: parts.join('\n'), boundaryCalls: [], parseErrors: [],
};
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

// Minimal adapter — only `cacheKey` (cache path) and `ruleHints` are read here.
const adapter = {
  id: 'typescript',
  cacheKey: (i: { configPathAbs?: string }) => `key-${i.configPathAbs ?? 'none'}`,
  ruleHints: undefined,
} as unknown as GraphLanguageAdapter;

describe('runShardedGraph', () => {
  let dir: string;
  let cliScript: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sharded-graph-'));
    cliScript = join(dir, 'fake-cli.cjs');
    writeFileSync(cliScript, WORKER_SCRIPT, 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function shard(id: string): Shard {
    return { id, rootDir: dir, files: [join(dir, `${id}.ts`)] };
  }

  it('merges shard fragments into a unified catalog, derives indexes, and runs rules', async () => {
    let evaluatedAgainst: Catalog | null = null;
    const rule: Rule = {
      id: 'test.rule',
      slug: 'test-rule',
      description: 'counts functions',
      evaluate: (catalog: Catalog, _indexes: Indexes) => {
        evaluatedAgainst = catalog;
        return [
          {
            ruleId: 'test.rule',
            message: `saw ${String(Object.keys(catalog.functions).length)} functions`,
            severity: 'warning',
          },
        ];
      },
    } as unknown as Rule;

    const out = await runShardedGraph({
      shards: [shard('pkg:a'), shard('pkg:b')],
      projectRoot: dir,
      cliScript,
      adapter,
      resolutionMode: 'exact',
      useCache: false,
      catalogRepo: null,
      rules: [rule],
    });

    expect(Object.keys(out.catalog.functions).sort()).toEqual(['pkg_a', 'pkg_b']);
    expect(out.indexes).not.toBeNull();
    expect(out.cacheHit).toBe(false);
    expect(out.failedShardIds).toEqual([]);
    expect(out.signals).toHaveLength(1);
    expect(out.signals[0]?.message).toBe('saw 2 functions');
    expect(evaluatedAgainst).not.toBeNull();
    expect(out.resolutionStats.totalCallSites).toBe(0);
  });

  it('emits the seven canonical stages onto onProgress (ADR-0032: engine-agnostic live view)', async () => {
    // The sharded build maps its work onto the SAME stages the single-program
    // (`runGraph`) path emits, so the live renderer shows one "Code Graph"
    // checklist for both engines. This pins the order + the discover/parse/walk/
    // resolve/rules sub-labels the runner surfaces.
    const events: { type: string; stage: string; detail?: string }[] = [];

    await runShardedGraph({
      shards: [shard('pkg:a'), shard('pkg:b')],
      projectRoot: dir,
      cliScript,
      adapter,
      resolutionMode: 'exact',
      useCache: false,
      catalogRepo: null,
      rules: [],
      onProgress: (e) => events.push({ type: e.type, stage: e.stage, ...(e.detail === undefined ? {} : { detail: e.detail }) }),
    });

    // Each of the 7 stages fires exactly one start + one done, in canonical order.
    const stageOrder = ['discover', 'parse', 'walk', 'resolve', 'index', 'features', 'rules'];
    const dones = events.filter((e) => e.type === 'stage-done').map((e) => e.stage);
    expect(dones).toEqual(stageOrder);
    const starts = events.filter((e) => e.type === 'stage-start').map((e) => e.stage);
    expect(starts).toEqual(stageOrder);

    // The familiar sub-labels carry the sharded work onto the exact checklist.
    const detailOf = (stage: string): string | undefined =>
      events.find((e) => e.type === 'stage-done' && e.stage === stage)?.detail;
    expect(detailOf('discover')).toBe('2 files');
    expect(detailOf('parse')).toBe('2 shards');
    expect(detailOf('walk')).toBe('2 functions');
    // Catalog-derived TOTAL call-site count — the SAME engine-agnostic metric
    // the exact path reports, with no "cross-shard" implementation leakage.
    expect(detailOf('resolve')).toMatch(/^\d+ call site\(s\)$/);
    expect(detailOf('resolve')).not.toMatch(/cross-shard/);
    expect(detailOf('rules')).toBe('0 rule(s), 0 signal(s)');
  });

  it('throws (fails loud) when two shards share an id', async () => {
    // Duplicate ids collide on the fragment-cache primary key and silently
    // corrupt the warm-build cache → non-determinism. The orchestrator must
    // refuse to build rather than return a quietly-wrong graph.
    await expect(
      runShardedGraph({
        shards: [shard('engine'), shard('engine')],
        projectRoot: dir,
        cliScript,
        adapter,
        resolutionMode: 'exact',
        useCache: false,
        catalogRepo: null,
        rules: [],
      }),
    ).rejects.toThrow(/Duplicate shard id\(s\) \[engine\]/);
  });

  it('records a failed shard id while still building the rest of the catalog', async () => {
    const out = await runShardedGraph({
      shards: [shard('pkg:a'), shard('fail:b')],
      projectRoot: dir,
      cliScript,
      adapter,
      resolutionMode: 'exact',
      useCache: false,
      catalogRepo: null,
      rules: [],
    });
    expect(out.failedShardIds).toEqual(['fail:b']);
    expect(Object.keys(out.catalog.functions)).toEqual(['pkg_a']);
    expect(out.signals).toEqual([]);
  });

  it('persists fragments and reports cacheHit when every shard is reused from cache', async () => {
    const datastore: DataStore = DataStoreFactory.open({ backend: 'memory' });
    const repo = new CatalogRepo(datastore);
    try {
      const shards = [shard('pkg:a'), shard('pkg:b')];

      // First run: cache cold, both shards built and their fragments persisted.
      const first = await runShardedGraph({
        shards,
        projectRoot: dir,
        cliScript,
        adapter,
        resolutionMode: 'exact',
        useCache: true,
        catalogRepo: repo,
        rules: [],
      });
      expect(first.cacheHit).toBe(false);

      // Second run: nothing changed → every shard reused, no worker runs.
      const second = await runShardedGraph({
        shards,
        projectRoot: dir,
        cliScript,
        adapter,
        resolutionMode: 'exact',
        useCache: true,
        catalogRepo: repo,
        rules: [],
      });
      expect(second.cacheHit).toBe(true);
      expect(Object.keys(second.catalog.functions).sort()).toEqual(['pkg_a', 'pkg_b']);
    } finally {
      datastore.close?.();
    }
  });
});
