/**
 * Operational smoke — bounded runtime for the sharded graph pipeline on a
 * minimal two-shard fixture (architecture review: orchestrate blast radius).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runShardedGraph } from '../sharded-graph.js';

import type { GraphLanguageAdapter } from '../../../lang-adapter/types.js';
import type { Shard } from '../shard-model.js';

const STAMPED_KEY = 'smoke-key';
const WORKER_SCRIPT = String.raw`
const { readFileSync } = require('node:fs');
const spec = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const id = spec.shard.id;
const name = id.replace(/[^a-zA-Z0-9]/g, '_');
const occ = {
  bodyHash: 'h-' + id, simpleName: name, qualifiedName: id + '.' + name,
  filePath: id + '/index.ts', line: 1, column: 0, endLine: 1,
  kind: 'function-declaration', params: [], returnType: null,
  enclosingClass: null, decorators: [], visibility: 'exported',
  inTestFile: false, definedInGenerated: false, calls: [],
};
const result = {
  shardId: id,
  fragment: {
    version: '3.0', tool: 'graph', language: 'typescript', builtAt: 'x',
    cacheKey: ${JSON.stringify(STAMPED_KEY)}, resolutionMode: 'exact', functions: { [name]: [occ] },
  },
  fingerprint: 'smoke', boundaryCalls: [], parseErrors: [],
};
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

const adapter = {
  id: 'typescript',
  cacheKey: () => STAMPED_KEY,
  ruleHints: undefined,
} as unknown as GraphLanguageAdapter;

const SMOKE_BUDGET_MS = 30_000;

describe('graph orchestrate operational smoke', () => {
  let dir: string;
  let cliScript: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-smoke-'));
    cliScript = join(dir, 'fake-cli.cjs');
    writeFileSync(cliScript, WORKER_SCRIPT, 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('completes two-shard run within budget', async () => {
    const shards: Shard[] = [
      { id: 'pkg:a', rootDir: dir, files: [join(dir, 'a.ts')] },
      { id: 'pkg:b', rootDir: dir, files: [join(dir, 'b.ts')] },
    ];

    const started = Date.now();
    const out = await runShardedGraph({
      shards,
      projectRoot: dir,
      cliScript,
      adapter,
      resolutionMode: 'exact',
      useCache: false,
      catalogRepo: null,
      rules: [],
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(SMOKE_BUDGET_MS);
    expect(Object.keys(out.catalog.functions)).toHaveLength(2);
    expect(out.failedShardIds).toEqual([]);
  });
});
