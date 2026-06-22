/**
 * dispatch-external-tool-command — the HOST supervisor for the out-of-process
 * external tool command dispatch plane (ADR-0054, increments M4-C / M4-D).
 *
 * For an EXTERNAL-provenance tool command (installed / project-local /
 * user-global), the host forks the {@link executeToolCommandWorker} entry
 * instead of importing + running the handler in-process. The worker imports the
 * untrusted runtime and runs the handler; this supervisor:
 *
 *   1. marshals the minimal serializable {@link ToolCommandWorkerSpec} to a temp
 *      file and forks the worker entry via the shared ADR-0028 transport
 *      ({@link createSubprocessProgressRun}), which already turns a child throw /
 *      `process.exit` / crash / premature-exit into a structured parent-side
 *      rejection and inherits run correlation through the child env;
 *   2. enforces a wall-clock timeout (supervisor-owned resource control,
 *      ADR-0054 Consequences) — a hung handler is SIGKILLed and surfaces as a
 *      structured failure, never a host hang;
 *   3. serves the worker's host-RPC upcalls mid-run (ADR-0054 M4-C): a
 *      {@link HostRpcRequest} streamed on the transport's `progress` arm is
 *      performed through the REAL host {@link ToolCliContext} (datastore /
 *      egress / FS / baselines / toolState / host planes) by
 *      {@link handleHostRpc}, and the {@link RpcReply} is sent back via
 *      `child.send` — the host remains the only process that performs the
 *      privileged effect;
 *   4. on success, replays the slim {@link ToolCommandResult} through the REAL
 *      host seams (`render` / `emitEnvelope` / `emitJson` / `emitRaw` /
 *      `emitError` / `setExitCode`) so the output contract stays byte-identical
 *      to the in-process path.
 *
 * Bundled first-party tools never reach here — they stay in-process (the trusted
 * computing base). External tools have NO in-process fallback by trust tier
 * (ADR-0054): a fork failure is a hard, structured error, not a silent in-host
 * run.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigurationError,
  currentScope,
  SystemError,
  type ToolError,
  type ToolProvenance,
  type ToolSource,
  type WorkerMessage,
} from '@opensip-cli/core';

import { BOOTSTRAP_MODULE } from './constants.js';
import { handleHostRpc } from './dispatch-host-rpc-handler.js';
import { replayResult, type DispatchHostCtx } from './dispatch-replay-result.js';

import type {
  HostRpcRequest,
  RpcReply,
  ToolCommandResult,
  ToolCommandWorkerSpec,
} from './tool-command-dispatch-types.js';

/** Default supervisor wall-clock timeout for one dispatched command (ms). */
const DEFAULT_DISPATCH_TIMEOUT_MS = 120_000;

/** The internal worker subcommand the supervisor forks the CLI binary into. */
const WORKER_SUBCOMMAND = '__tool-command-worker';

/** The dispatch IPC binding: host-RPC requests stream on `progress`. */
type DispatchWorkerMessage = WorkerMessage<HostRpcRequest, ToolCommandResult>;

/** Narrowing helper: a worker `error` IPC message carries an optional failureClass/stack. */
type DispatchWorkerError = Extract<DispatchWorkerMessage, { kind: 'error' }>;

export interface DispatchExternalToolCommandArgs {
  /** The external tool's provenance (source must NOT be `'bundled'`). */
  readonly provenance: ToolProvenance;
  /** Which command (by `CommandSpec.name`) to run in the worker. */
  readonly commandName: string;
  /** Parsed opts for this invocation (serializable). */
  readonly opts: Record<string, unknown>;
  /** Trailing positionals (`_args`) for this invocation (serializable). */
  readonly positionals: readonly unknown[];
  /**
   * The tool's RAW config namespace block for the WORKER deep pass (ADR-0054
   * M4-E Config two-pass). Forwarded into the spec so the worker runs the tool's
   * real Zod after load. `undefined` when there is no block to validate.
   */
  readonly config?: unknown;
  /** The real host context the supervisor replays the worker result through. */
  readonly ctx: DispatchHostCtx;
  /** Override the wall-clock timeout (tests use a short one). */
  readonly timeoutMs?: number;
  /**
   * Override the CLI entry script the supervisor forks (defaults to
   * `process.argv[1]`). The worker runs as `node <cliScript> __tool-command-worker
   * <specPath> --cwd <cwd>`, going through the full bootstrap so the dispatched
   * tool's scope (config/registries/subscope) is worker-local (ADR-0054 M4-E).
   * Tests point this at the built CLI dist entry.
   */
  readonly cliScript?: string;
}

/**
 * Fork the worker, await its slim {@link ToolCommandResult}, and replay it
 * through the host seams. A worker fault (throw / `process.exit` / crash /
 * timeout) becomes a structured {@link ToolError} — the host never crashes.
 *
 * @throws {SystemError} when the external command's provenance is `'bundled'`
 *   (a misuse — bundled tools run in-process), or when the worker fails.
 */
export async function dispatchExternalToolCommand(
  args: DispatchExternalToolCommandArgs,
): Promise<void> {
  if (args.provenance.source === 'bundled') {
    throw new SystemError(
      'dispatchExternalToolCommand called for a bundled tool; bundled tools run in-process.',
      { code: 'SYSTEM.DISPATCH.BUNDLED_MISUSE' },
    );
  }

  // Lifecycle observability: the out-of-process dispatch is a major run phase, so
  // emit a structured event onto the scope DiagnosticsBus (the same bus the
  // in-process action emits `execute` events onto). A `--json` consumer reads
  // `outcome.diagnostics.events` for context even without full OTEL.
  const diagnostics = currentScope()?.diagnostics;
  diagnostics?.event(
    'execute',
    'debug',
    `dispatching external tool '${args.provenance.id}' command '${args.commandName}' out-of-process`,
  );
  const result = await runWorker(args);
  diagnostics?.event(
    'execute',
    'debug',
    `external tool '${args.provenance.id}' command '${args.commandName}' worker resolved`,
  );
  await replayResult(result, args.ctx, {
    commandName: args.commandName,
    opts: { ...args.opts, _args: args.positionals },
    positionals: args.positionals,
  });
}

/**
 * Marshal the spec to a temp file, fork the worker entry, enforce the timeout,
 * and resolve the worker's {@link ToolCommandResult} (or reject with a
 * structured {@link ToolError}). The temp dir is always cleaned up.
 */
async function runWorker(args: DispatchExternalToolCommandArgs): Promise<ToolCommandResult> {
  const spec: ToolCommandWorkerSpec = {
    toolId: args.provenance.id,
    toolPackageDir: requirePackageDir(args.provenance),
    source: args.provenance.source as Exclude<ToolSource, 'bundled'>,
    commandName: args.commandName,
    opts: args.opts,
    positionals: args.positionals,
    // ADR-0054 M4-E: forward the coarse-validated config block so the worker can
    // run the tool's real Zod deep pass after load. Omitted when no block exists.
    ...(args.config === undefined ? {} : { config: args.config }),
  };

  const dir = mkdtempSync(join(tmpdir(), 'opensip-tool-dispatch-'));
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(spec), 'utf8');

  // Fork the CLI binary as the `__tool-command-worker` subcommand so the FULL
  // bootstrap runs in the worker (the tool's scope is re-built worker-local;
  // ADR-0054 M4-E). `--cwd` targets the same project the parent run resolved.
  const cliScript = args.cliScript ?? process.argv[1] ?? '';
  const cwd = typeof args.opts.cwd === 'string' ? args.opts.cwd : process.cwd();
  const timeoutMs = args.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;

  try {
    return await forkAndAwait(cliScript, specPath, cwd, spec, timeoutMs, args.ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The low-level fork + IPC settle. Mirrors the shared subprocess transport's
 * single-settle / kill-on-settle discipline, but adds a supervisor timeout, the
 * M4-C host-RPC reply channel, and binds the COMMAND result/error shapes. Kept
 * self-contained (not routed through `createSubprocessProgressRun`) because this
 * path needs the rpc-reply direction (`child.send`) the fire-and-forget transport
 * does not have, plus an owned timeout + correlation env injection symmetric to
 * the transport.
 *
 * The wall-clock timeout is a HARD cap on the WHOLE command (resource control,
 * ADR-0054 Consequences) — it is deliberately NOT reset on each RPC, so a
 * runaway upcall loop is still SIGKILLed rather than extending the budget
 * indefinitely.
 */
function forkAndAwait(
  cliScript: string,
  specPath: string,
  cwd: string,
  spec: ToolCommandWorkerSpec,
  timeoutMs: number,
  ctx: DispatchHostCtx,
): Promise<ToolCommandResult> {
  return new Promise<ToolCommandResult>((resolve, reject) => {
    const runId = currentScope()?.runId;
    const childEnv =
      runId === undefined || runId.length === 0
        ? undefined
        : // @fitness-ignore-next-line env-secret-exposure -- fork() with an `env` set REPLACES the child env wholesale, so the parent env must be spread in to preserve PATH/HOME/etc.; only OPENSIP_RUN_ID (no secret) is added, and this object is passed to fork, never logged (parity with subprocess-transport's childEnv).
          { ...process.env, OPENSIP_RUN_ID: runId };

    // Fork the CLI binary into the internal worker subcommand. The full bootstrap
    // (preAction) re-builds the per-run scope in the worker before the worker
    // handler runs.
    //
    // `cwd` is set on the CHILD PROCESS (not only passed as `--cwd`): the CLI
    // bootstrap anchors TOOL DISCOVERY on `process.cwd()` (`bootstrapCli({ cwd:
    // process.cwd() })`), while the `--cwd` flag only steers later PROJECT
    // resolution in the pre-action hook. Forking the worker without setting the
    // child's real cwd would discover tools from the SUPERVISOR's directory, so
    // the dispatched external tool — installed under the target project's
    // `node_modules` — would not be in the worker's registry and `resolveTool`
    // would fail `runtime-load-failed`. Pinning the child cwd to the same project
    // the `--cwd` flag names keeps discovery and project resolution coherent: the
    // worker bootstraps exactly as an in-project invocation would.
    const child = fork(cliScript, [WORKER_SUBCOMMAND, specPath, '--cwd', cwd], {
      cwd,
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      serialization: 'advanced',
      ...(childEnv === undefined ? {} : { env: childEnv }),
    });

    let settled = false;
    // `done` closes over `timer` (assigned just below); it is never CALLED before
    // the const is initialized, so the forward reference is safe.
    const done = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      apply();
      child.kill();
    };

    const timer = setTimeout(() => {
      done(() => {
        child.kill('SIGKILL');
        reject(dispatchError(spec, `worker timed out after ${String(timeoutMs)}ms`, 'timeout'));
      });
    }, timeoutMs);
    timer.unref?.();

    // M4-C: serve one host-RPC upcall against the REAL host ctx and reply. A
    // host-side fault is folded into a structured `{ ok: false }` reply by
    // handleHostRpc — never an unhandled host crash. If the child has already
    // settled (raced a result/exit), the reply is dropped (the worker is gone).
    const serveRpc = (request: HostRpcRequest): void => {
      void handleHostRpc(request, ctx).then((reply: RpcReply) => {
        if (!settled) sendRpcReply(child, reply, spec);
      });
    };

    child.on('message', (msg: DispatchWorkerMessage) => {
      if (msg.kind === 'progress') {
        serveRpc(msg.event);
      } else if (msg.kind === 'result') {
        done(() => {
          resolve(msg.value);
        });
      } else {
        done(() => {
          reject(workerErrorToToolError(spec, msg));
        });
      }
    });
    child.on('error', (err: Error) => {
      done(() => {
        // ADR-0054 M4-E trust tier: an external tool that cannot fork is a HARD
        // error — NEVER an in-host fallback (that would run untrusted code in the
        // kernel process). A future explicitly-named developer override
        // (OPENSIP_CLI_DANGEROUSLY_RUN_EXTERNAL_IN_HOST) is reserved, not built.
        reject(
          dispatchError(
            spec,
            `cannot isolate external tool '${spec.toolId}' (worker fork failed: ${err.message}); ` +
              'refusing to run it in-process',
            'spawn',
          ),
        );
      });
    });
    child.on('exit', (code: number | null) => {
      done(() => {
        reject(
          dispatchError(
            spec,
            `worker exited (code ${code ?? 'null'}) before producing a result`,
            'exit_nonzero',
          ),
        );
      });
    });
  });
}

/** Resolve the package dir for an external tool, or fail with a structured error. */
function requirePackageDir(provenance: ToolProvenance): string {
  const dir = provenance.resolvedPath;
  if (dir === undefined || dir.length === 0) {
    throw new SystemError(
      `external tool '${provenance.id}' has no resolved package path to dispatch from`,
      { code: 'SYSTEM.DISPATCH.NO_PACKAGE_DIR' },
    );
  }
  return dir;
}

/**
 * Post one host-RPC {@link RpcReply} back to the worker, only while the child is
 * still attached: a settle (result/exit/timeout) kills it, after which
 * `child.send` would write to a closed channel. The send callback swallows a
 * racing EPIPE (the channel can close between the `connected` check and the
 * write) so a reply to a departing worker never surfaces as a spurious dispatch
 * failure — a dropped reply is logged at debug and otherwise ignored.
 */
function sendRpcReply(child: ChildProcess, reply: RpcReply, spec: ToolCommandWorkerSpec): void {
  if (!child.connected) return;
  child.send(reply, (err) => {
    if (err === null) return;
    currentScope()?.logger.debug({
      evt: 'cli.tool.dispatch_rpc_reply_dropped',
      module: BOOTSTRAP_MODULE,
      toolId: spec.toolId,
      command: spec.commandName,
    });
  });
}

/** Build a structured supervisor-side dispatch error, logged with its failure class. */
function dispatchError(
  spec: ToolCommandWorkerSpec,
  message: string,
  failureClass: string,
): ToolError {
  currentScope()?.logger.error({
    evt: 'cli.tool.dispatch_failed',
    module: BOOTSTRAP_MODULE,
    toolId: spec.toolId,
    command: spec.commandName,
    failureClass,
  });
  // ADR-0054 M4-E single config-error contract: a worker DEEP-pass config
  // failure (`config-invalid`) maps to the SAME typed error + exit code
  // (ConfigurationError → CONFIGURATION_ERROR, exit 2) the host COARSE pass
  // throws, so the user sees a consistent "Invalid configuration …" regardless
  // of which pass caught it. The worker's message already names the namespace+key.
  if (failureClass === 'config-invalid') {
    return new ConfigurationError(message, { code: 'CONFIGURATION_ERROR', failureClass });
  }
  return new SystemError(
    `external tool '${spec.toolId}' command '${spec.commandName}' failed: ${message}`,
    { code: 'SYSTEM.DISPATCH.WORKER_FAILED', failureClass },
  );
}

/** Convert a worker `error` IPC message into a logged, structured {@link ToolError}. */
function workerErrorToToolError(spec: ToolCommandWorkerSpec, msg: DispatchWorkerError): ToolError {
  return dispatchError(spec, msg.message, msg.failureClass ?? 'ipc_error');
}
