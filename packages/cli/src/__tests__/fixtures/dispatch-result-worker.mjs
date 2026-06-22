/**
 * Tiny worker fixture for the ADR-0054 supervisor replay tests. Stands in for the
 * full worker entry so the supervisor's replay/failure arms are exercised in the
 * instrumented host WITHOUT the full CLI bootstrap (discovery/config/scope).
 *
 * The M4-E supervisor forks the worker as a CLI SUBCOMMAND:
 *   `node <script> __tool-command-worker <specPath> --cwd <cwd>`
 * so when this fixture is the forked `<script>`, its argv is
 *   [node, fixture, '__tool-command-worker', <specPath>, '--cwd', <cwd>]
 * — i.e. the spec path is the arg AFTER the worker subcommand, NOT argv[2]. The
 * real worker entry reads it the same way (Commander `_args[0]` after the
 * subcommand). Resolve it from that shape (fall back to the first `.json` arg) so
 * the fixture is a faithful protocol stand-in under the M4-E fork contract.
 *
 * Speaks the WorkerMessage IPC protocol (`serialization: 'advanced'`). The spec
 * file's `mode` selects which ToolCommandResult shape to post back, so
 * `replayResult` arms (render / json / raw / error / exitCode) and the
 * error/timeout paths are all exercisable.
 */
import { readFileSync } from 'node:fs';

const WORKER_SUBCOMMAND = '__tool-command-worker';
const args = process.argv.slice(2);
const subIdx = args.indexOf(WORKER_SUBCOMMAND);
const specPath =
  subIdx >= 0 ? args[subIdx + 1] : (args.find((a) => a.endsWith('.json')) ?? args[0]);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
// A hook-mode spec (M4-F) carries `hook` instead of a command `mode`; route it to
// the `hook-result` shape so the hook supervisor's hookResult extraction is covered.
const mode = spec.hook !== undefined ? 'hook-result' : (spec.opts?.mode ?? 'envelope');
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
  case 'config-invalid': {
    // M4-E/M4-F: a worker DEEP-pass config failure crosses as `config-invalid`;
    // the supervisor maps it to the SAME typed ConfigurationError (exit 2).
    send({
      kind: 'error',
      message: "Invalid configuration for 'x': x.k: bad",
      failureClass: 'config-invalid',
    });
    break;
  }
  case 'hook-result': {
    // M4-F hook mode: the worker returns a plain-data hookResult. The hook
    // supervisor (dispatchExternalToolHook) extracts and returns it.
    send({ kind: 'result', value: { output: 'command-result', hookResult: { ok: true, n: 42 } } });
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
