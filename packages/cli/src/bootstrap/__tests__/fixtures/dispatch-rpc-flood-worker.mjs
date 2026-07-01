/**
 * Emits more host-RPC requests than the configured total cap.
 */
import { readFileSync } from 'node:fs';

const WORKER_SUBCOMMAND = '__tool-command-worker';
const arguments_ = process.argv.slice(2);
const subIndex = arguments_.indexOf(WORKER_SUBCOMMAND);
const specPath =
  subIndex === -1
    ? (arguments_.find((a) => a.endsWith('.json')) ?? arguments_[0])
    : arguments_[subIndex + 1];
readFileSync(specPath, 'utf8');
const send = (message) => process.send?.(message);

for (let index = 1; index <= 5; index += 1) {
  send({ kind: 'progress', event: { rpcId: index, seam: 'getExitCode' } });
}
send({ kind: 'result', value: { output: 'command-result', exitCode: 0 } });
