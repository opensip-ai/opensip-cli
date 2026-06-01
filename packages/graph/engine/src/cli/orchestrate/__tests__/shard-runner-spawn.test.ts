/**
 * Shard runner — the parallel-spawn path (`runShardsInParallel`).
 *
 * Drives real child processes via a tiny fixture "CLI" script that
 * stands in for `graph-shard-worker`: it reads the spec temp file the
 * runner writes, and emits either a valid `ShardBuildResult` JSON on
 * stdout (success) or a non-zero exit with stderr (failure), keyed by
 * the shard id. This exercises spec-file write, spawn, stdout capture,
 * JSON parse, success/failure partitioning, and deterministic ordering
 * without standing up a TypeScript build.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runShardsInParallel } from '../shard-runner.js';

import type { Shard } from '../shard-model.js';

// A fixture worker script. Invoked as `node <script> graph-shard-worker <specPath>`.
// Shards whose id starts with 'fail:' exit non-zero; everything else emits a
// minimal valid ShardBuildResult echoing the shard id.
const WORKER_SCRIPT = String.raw`
const { readFileSync } = require('node:fs');
const specPath = process.argv[3];
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const id = spec.shard.id;
if (id.startsWith('fail:')) {
  process.stderr.write('boom for ' + id + '\n');
  process.exit(3);
}
const result = {
  shardId: id,
  fragment: {
    version: '3.0', tool: 'graph', language: 'typescript',
    builtAt: 'x', cacheKey: 'k-' + id, resolutionMode: 'exact', functions: {},
  },
  fingerprint: 'fp-' + id,
  boundaryCalls: [],
  parseErrors: [],
};
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

describe('runShardsInParallel', () => {
  let dir: string;
  let cliScript: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shard-spawn-'));
    cliScript = join(dir, 'fake-cli.cjs');
    writeFileSync(cliScript, WORKER_SCRIPT, 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function shard(id: string): Shard {
    return { id, rootDir: dir, files: [join(dir, `${id}.ts`)] };
  }

  it('builds every shard and returns fragments in deterministic shard-id order', async () => {
    const out = await runShardsInParallel({
      shards: [shard('pkg:c'), shard('pkg:a'), shard('pkg:b')],
      projectRoot: dir,
      cliScript,
      resolutionMode: 'exact',
      concurrency: 2,
    });
    expect(out.failures).toHaveLength(0);
    expect(out.fragments.map((f) => f.shardId)).toEqual(['pkg:a', 'pkg:b', 'pkg:c']);
    expect(out.fragments[0]?.fingerprint).toBe('fp-pkg:a');
  });

  it('attributes a non-zero worker exit to its shard as a failure, not a throw', async () => {
    const out = await runShardsInParallel({
      shards: [shard('pkg:ok'), shard('fail:x')],
      projectRoot: dir,
      cliScript,
      resolutionMode: 'exact',
    });
    expect(out.fragments.map((f) => f.shardId)).toEqual(['pkg:ok']);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]?.shardId).toBe('fail:x');
    expect(out.failures[0]?.exitCode).toBe(3);
    expect(out.failures[0]?.stderr).toContain('boom for fail:x');
  });

  it('handles an empty shard set', async () => {
    const out = await runShardsInParallel({
      shards: [],
      projectRoot: dir,
      cliScript,
      resolutionMode: 'exact',
    });
    expect(out.fragments).toEqual([]);
    expect(out.failures).toEqual([]);
  });
});
