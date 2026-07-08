// A CLI worker spawn that forwards env but NOT correlation — one error finding.
import { spawn } from 'node:child_process';

export function spawnShardWorker(cliScript: string, specPath: string): void {
  // Forwards the parent environment to the child worker subcommand but never
  // merges the RunCorrelation bag — a child failure cannot be attributed to the
  // parent run. The subprocess-correlation-required check fires here.
  spawn(process.execPath, [cliScript, 'graph-shard-worker', specPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}
