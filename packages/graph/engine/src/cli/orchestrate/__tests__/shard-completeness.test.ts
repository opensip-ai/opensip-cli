import { describe, expect, it } from 'vitest';

import {
  assertShardedBuildComplete,
  assertShardedBuildUsable,
  requireCompleteShardedCatalog,
} from '../shard-completeness.js';
import { boundedShardFailureEvidence } from '../shard-runner.js';

describe('assertShardedBuildComplete', () => {
  it('accepts a complete sharded result', () => {
    expect(() => assertShardedBuildComplete({ failedShardIds: [] })).not.toThrow();
  });

  it('rejects a partial result with attributable shard identities', () => {
    expect(() =>
      assertShardedBuildComplete({
        failedShardIds: ['fitness/checks-dogfood', 'graph/engine'],
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'GRAPH.SHARD.FAILURES',
        message: expect.stringContaining('fitness/checks-dogfood, graph/engine'),
      }),
    );
  });

  it('bounds the shard identities included in the error', () => {
    const failedShardIds = Array.from({ length: 12 }, (_, index) => `shard-${String(index)}`);

    expect(() => assertShardedBuildComplete({ failedShardIds })).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('shard-9 (+2 more)'),
      }),
    );
  });

  it('never returns a catalog assembled from partial shard evidence', () => {
    const partial = {
      catalog: { functions: ['incomplete'] },
      failedShardIds: ['fitness/checks-dogfood'],
    };

    expect(() => requireCompleteShardedCatalog(partial)).toThrow(
      expect.objectContaining({ code: 'GRAPH.SHARD.FAILURES' }),
    );
  });

  it('surfaces bounded worker classification and stderr on a partial result', () => {
    const failure = boundedShardFailureEvidence({
      shardId: 'graph/graph-java',
      exitCode: 1,
      failureClass: 'exit_nonzero',
      signal: 'SIGKILL',
      errorCode: 'GRAPH.CATALOG.UNREADABLE',
      stderr: `${'x'.repeat(1200)}worker root cause api_key=supersecretvalue`,
    });

    expect(failure.stderrTail).toHaveLength(1000);
    expect(failure.stderrTail).toContain('[redacted]');
    expect(failure.stderrTail).not.toContain('supersecretvalue');
    expect(() =>
      assertShardedBuildComplete({
        failedShardIds: [failure.shardId],
        shardFailures: [failure],
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'GRAPH.SHARD.FAILURES',
        failureClass: 'exit_nonzero',
        stderrTail: expect.stringContaining('worker root cause'),
        message: expect.stringContaining(
          'graph/graph-java (exit_nonzero, exit 1, signal SIGKILL, code GRAPH.CATALOG.UNREADABLE)',
        ),
      }),
    );
  });

  it('accepts partial evidence for an ordinary run when at least one shard survived', () => {
    expect(() =>
      assertShardedBuildUsable({
        failedShardIds: ['fail:a'],
        successfulShardCount: 1,
      }),
    ).not.toThrow();
  });

  it('hard-fails when no shard produced usable evidence', () => {
    expect(() =>
      assertShardedBuildUsable({
        failedShardIds: ['fail:a', 'fail:b'],
        successfulShardCount: 0,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'GRAPH.SHARD.FAILURES',
        metadata: expect.objectContaining({
          condition: 'no-usable-shards',
          count: 2,
        }),
      }),
    );
  });

  it('keeps the scrubbed stderr tail out of the public error message', () => {
    const failure = boundedShardFailureEvidence({
      shardId: 'fail:a',
      exitCode: 1,
      stderr: 'sensitive worker detail',
    });
    expect(() =>
      assertShardedBuildComplete({
        failedShardIds: [failure.shardId],
        shardFailures: [failure],
      }),
    ).toThrow(
      expect.objectContaining({
        stderrTail: 'sensitive worker detail',
        message: expect.not.stringContaining('sensitive worker detail'),
      }),
    );
  });
});
