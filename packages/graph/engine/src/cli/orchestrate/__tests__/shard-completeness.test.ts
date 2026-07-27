import { describe, expect, it } from 'vitest';

import {
  assertShardedBuildComplete,
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
        code: 'GRAPH.BUILD.INCOMPLETE',
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
      expect.objectContaining({ code: 'GRAPH.BUILD.INCOMPLETE' }),
    );
  });

  it('surfaces bounded worker classification and stderr on a partial result', () => {
    const failure = boundedShardFailureEvidence({
      shardId: 'graph/graph-java',
      exitCode: 1,
      failureClass: 'exit_nonzero',
      signal: 'SIGKILL',
      stderr: `${'x'.repeat(1200)}worker root cause`,
    });

    expect(failure.stderrTail).toHaveLength(1000);
    expect(() =>
      assertShardedBuildComplete({
        failedShardIds: [failure.shardId],
        shardFailures: [failure],
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'GRAPH.BUILD.INCOMPLETE',
        failureClass: 'exit_nonzero',
        stderrTail: expect.stringContaining('worker root cause'),
        message: expect.stringContaining('graph/graph-java (exit_nonzero, exit 1, signal SIGKILL)'),
      }),
    );
  });
});
