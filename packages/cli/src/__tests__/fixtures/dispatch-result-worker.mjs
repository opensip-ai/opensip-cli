/**
 * Tiny worker fixture for the ADR-0054 supervisor replay tests. Forked as
 * `node dispatch-result-worker.mjs <specPath>` with `serialization: 'advanced'`;
 * speaks the WorkerMessage IPC protocol. The spec file's `mode` selects which
 * ToolCommandResult shape to post back, so `replayResult` arms (render / json /
 * raw / error / exitCode) and the error/timeout paths are all exercisable
 * without the full worker entry.
 */
import { readFileSync } from 'node:fs';

const specPath = process.argv[2];
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const mode = spec.opts?.mode ?? 'envelope';
const send = (msg) => process.send?.(msg);

switch (mode) {
  case 'all-frr': {
    // Every final-result-return seam at once, to cover each replay arm.
    send({
      kind: 'result',
      value: {
        output: 'command-result',
        render: { type: 'help' },
        json: { a: 1 },
        raw: 'raw-line',
        error: { message: 'oops', exitCode: 2, suggestion: 'fix it', code: 'X' },
        exitCode: 7,
      },
    });
    break;
  }
  case 'error-msg': {
    send({ kind: 'error', message: 'worker reported failure', failureClass: 'tool-handler-throw' });
    break;
  }
  case 'progress-then-result': {
    // With M4-C the `progress` arm carries a host-RPC request. A malformed one
    // (no matching `seam`) must be tolerated host-side (the supervisor serves it,
    // dropping the reply as this worker exits) and the run must still settle on
    // the result that follows — never a spurious dispatch failure.
    send({ kind: 'progress', event: { rpcId: 1 } });
    send({ kind: 'result', value: { output: 'signal-envelope', exitCode: 0 } });
    break;
  }
  default: {
    send({
      kind: 'result',
      value: { output: 'signal-envelope', envelope: { tool: 't' }, exitCode: 0 },
    });
  }
}
