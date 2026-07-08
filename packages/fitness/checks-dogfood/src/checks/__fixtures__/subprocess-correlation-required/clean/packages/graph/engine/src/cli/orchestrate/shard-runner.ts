// A CLI worker spawn that forwards the RunCorrelation bag — clean (no finding).
import { spawn } from 'node:child_process';

import { correlationToEnv, currentScope } from '@opensip-cli/core';

interface ShardSpec {
  readonly shardId: string;
  readonly correlation?: Record<string, string>;
}

export function spawnShardWorker(cliScript: string, specPath: string, shardId: string): void {
  const correlation = currentScope()?.correlation;

  const spec: ShardSpec = {
    shardId,
    // Carry the correlation (sans runId) onto the worker spec so the child
    // stamps it on spans/logs.
    ...(correlation ? { correlation: correlationToEnv(correlation) } : {}),
  };
  void spec;

  spawn(process.execPath, [cliScript, 'graph-shard-worker', specPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Correlation env (incl. OPENSIP_RUN_ID) so the child inherits the run.
      ...(correlation ? correlationToEnv(correlation) : {}),
    },
  });
}
