/**
 * Emits more host-RPC requests than the configured total cap.
 */
import { readFileSync } from 'node:fs';

const WORKER_SUBCOMMAND = '__tool-command-worker';
const args = process.argv.slice(2);
const subIdx = args.indexOf(WORKER_SUBCOMMAND);
const specPath =
  subIdx >= 0 ? args[subIdx + 1] : (args.find((a) => a.endsWith('.json')) ?? args[0]);
readFileSync(specPath, 'utf8');
const send = (msg) => process.send?.(msg);

for (let i = 1; i <= 5; i += 1) {
  send({ kind: 'progress', event: { rpcId: i, seam: 'getExitCode' } });
}
send({ kind: 'result', value: { output: 'command-result', exitCode: 0 } });
