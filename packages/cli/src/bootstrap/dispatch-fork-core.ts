/**
 * dispatch-fork-core — the shared fork + IPC settle + host-RPC supervisor for the
 * ADR-0054 out-of-process external-tool worker (increments M4-C / M4-D / M4-F).
 *
 * Both supervisors fork the SAME internal `__tool-command-worker` subcommand and
 * settle on the SAME `ToolCommandResult` shape:
 *   - `dispatch-external-tool-command.ts` runs an external tool's COMMAND;
 *   - `dispatch-external-tool-hook.ts` (M4-F) runs an external tool's LIFECYCLE
 *     HOOK (`collectReportData` / `sessionReplay`).
 *
 * They differ only in the {@link ToolCommandWorkerSpec} they marshal (a
 * `commandName` vs a `hook`) and how they replay the result. This module owns the
 * common machinery so neither duplicates it: marshal the spec to a temp file,
 * fork the CLI binary as the worker subcommand (full bootstrap re-runs
 * worker-local), enforce a wall-clock timeout, serve mid-run host-RPC upcalls
 * against the REAL host `ToolCliContext`, and resolve the worker's
 * {@link ToolCommandResult} (or reject with a structured {@link ToolError}).
 *
 * The host remains the ONLY process that performs the privileged effect; a worker
 * fault (throw / `process.exit` / crash / timeout / fork failure) becomes a
 * structured parent-side {@link ToolError} — the host never crashes and external
 * runtime NEVER falls back to in-host execution (ADR-0054 trust tier).
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
  type WorkerMessage,
} from '@opensip-cli/core';

import { BOOTSTRAP_MODULE } from './constants.js';
import { handleHostRpc } from './dispatch-host-rpc-handler.js';
import { type DispatchHostCtx } from './dispatch-replay-result.js';
import { IN_TOOL_WORKER_ENV } from './tool-provenance.js';

import type {
  HostRpcRequest,
  RpcReply,
  ToolCommandResult,
  ToolCommandWorkerSpec,
} from './tool-command-dispatch-types.js';

/** Default supervisor wall-clock timeout for one forked worker run (ms). */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 120_000;

/** The internal worker subcommand the supervisor forks the CLI binary into. */
export const WORKER_SUBCOMMAND = '__tool-command-worker';

/** The dispatch IPC binding: host-RPC requests stream on `progress`. */
type DispatchWorkerMessage = WorkerMessage<HostRpcRequest, ToolCommandResult>;

/** Narrowing helper: a worker `error` IPC message carries an optional failureClass/stack. */
type DispatchWorkerError = Extract<DispatchWorkerMessage, { kind: 'error' }>;

/** Resolve the package dir for an external tool, or fail with a structured error. */
export function requirePackageDir(provenance: ToolProvenance): string {
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
 * Marshal a worker spec to a temp file, fork the worker, enforce the timeout, and
 * resolve the worker's {@link ToolCommandResult}. The temp dir is always cleaned
 * up. `cliScript` defaults to the running CLI entry; tests point it at the dist
 * entry. `cwd` defaults to the spec's `opts.cwd` (or `process.cwd()`).
 */
export async function runWorkerSpec(args: {
  readonly spec: ToolCommandWorkerSpec;
  readonly ctx: DispatchHostCtx;
  readonly cwd: string;
  readonly cliScript?: string;
  readonly timeoutMs?: number;
}): Promise<ToolCommandResult> {
  const dir = mkdtempSync(join(tmpdir(), 'opensip-tool-dispatch-'));
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(args.spec), 'utf8');

  const cliScript = args.cliScript ?? process.argv[1] ?? '';
  const timeoutMs = args.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;

  try {
    return await forkAndAwait({
      cliScript,
      specPath,
      cwd: args.cwd,
      spec: args.spec,
      timeoutMs,
      ctx: args.ctx,
    });
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
 * The wall-clock timeout is a HARD cap on the WHOLE run (resource control,
 * ADR-0054 Consequences) — it is deliberately NOT reset on each RPC, so a runaway
 * upcall loop is still SIGKILLed rather than extending the budget indefinitely.
 */
interface ForkAndAwaitInput {
  readonly cliScript: string;
  readonly specPath: string;
  readonly cwd: string;
  readonly spec: ToolCommandWorkerSpec;
  readonly timeoutMs: number;
  readonly ctx: DispatchHostCtx;
}

function forkAndAwait({
  cliScript,
  specPath,
  cwd,
  spec,
  timeoutMs,
  ctx,
}: ForkAndAwaitInput): Promise<ToolCommandResult> {
  return new Promise<ToolCommandResult>((resolve, reject) => {
    const runId = currentScope()?.runId;
    // ADR-0054 M4-F: the child IS the isolation boundary. OPENSIP_CLI_IN_TOOL_WORKER
    // tells the worker bootstrap to RUN the dispatched external tool's lifecycle
    // hooks worker-local (the host-skip is disabled there). OPENSIP_RUN_ID stitches
    // the worker's logs to the parent run. fork() with `env` set REPLACES the child
    // env, so the parent env is spread in first to preserve PATH/HOME/etc.
    // @fitness-ignore-next-line env-secret-exposure -- spreading process.env preserves PATH/HOME for the child; only OPENSIP_RUN_ID (no secret) + the OPENSIP_CLI_IN_TOOL_WORKER marker are added; this object is passed to fork, never logged (parity with subprocess-transport's childEnv).
    const childEnv: NodeJS.ProcessEnv = { ...process.env, [IN_TOOL_WORKER_ENV]: '1' };
    if (runId !== undefined && runId.length > 0) childEnv.OPENSIP_RUN_ID = runId;

    // Fork the CLI binary into the internal worker subcommand. The full bootstrap
    // (preAction) re-builds the per-run scope in the worker before the worker
    // handler runs.
    //
    // `cwd` is set on the CHILD PROCESS (not only passed as `--cwd`): the CLI
    // bootstrap anchors TOOL DISCOVERY on `process.cwd()`, while the `--cwd` flag
    // only steers later PROJECT resolution in the pre-action hook. Pinning the
    // child cwd to the same project keeps discovery and project resolution
    // coherent — the worker bootstraps exactly as an in-project invocation would.
    const child = fork(cliScript, [WORKER_SUBCOMMAND, specPath, '--cwd', cwd], {
      cwd,
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      serialization: 'advanced',
      env: childEnv,
    });

    let settled = false;
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
    /* v8 ignore next 16 -- defensive isolation-safety arm: `child.on('error')` fires only on a node-executable SPAWN failure (ENOENT on the runtime, EACCES), which is only reachable via impractical fault injection — node always exists in a normal run, so a bad worker entry surfaces via `child.on('exit')` (the covered sibling arm) instead. ADR-0054 trust tier: an external tool that cannot fork is a HARD error, NEVER an in-host fallback (that would run untrusted code in the kernel process). A future explicitly-named developer override (OPENSIP_CLI_DANGEROUSLY_RUN_EXTERNAL_IN_HOST) is reserved, not built. */
    child.on('error', (err: Error) => {
      done(() => {
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

/**
 * Post one host-RPC {@link RpcReply} back to the worker, only while the child is
 * still attached: a settle (result/exit/timeout) kills it, after which
 * `child.send` would write to a closed channel. The send callback swallows a
 * racing EPIPE so a reply to a departing worker never surfaces as a spurious
 * dispatch failure — a dropped reply is logged at debug and otherwise ignored.
 */
function sendRpcReply(child: ChildProcess, reply: RpcReply, spec: ToolCommandWorkerSpec): void {
  if (!child.connected) return;
  child.send(reply, (err) => {
    if (err === null) return;
    /* v8 ignore next 6 -- defensive race arm: the channel can close between the `connected` check and the async `child.send` write (the child settled/exited concurrently). The dropped-reply debug log is only reachable via that microtask-level race, not deterministically testable; a dropped reply to a departing worker is harmless (the worker is gone). */
    currentScope()?.logger.debug({
      evt: 'cli.tool.dispatch_rpc_reply_dropped',
      module: BOOTSTRAP_MODULE,
      toolId: spec.toolId,
      command: spec.commandName ?? spec.hook ?? 'unknown',
    });
  });
}

/**
 * The human label for the dispatched unit — the command name, or (hook mode) the
 * hook name. A valid spec always names one; the final fallback is defensive.
 */
function specLabel(spec: ToolCommandWorkerSpec): string {
  /* v8 ignore next -- defensive: a valid spec always carries a commandName OR a hook (the worker entry rejects one that has neither as bad-spec); the 'unknown' fallback is structurally unreachable. */
  return spec.commandName ?? spec.hook ?? 'unknown';
}

/** Build a structured supervisor-side dispatch error, logged with its failure class. */
export function dispatchError(
  spec: ToolCommandWorkerSpec,
  message: string,
  failureClass: string,
): ToolError {
  const label = specLabel(spec);
  currentScope()?.logger.error({
    evt: 'cli.tool.dispatch_failed',
    module: BOOTSTRAP_MODULE,
    toolId: spec.toolId,
    command: label,
    failureClass,
  });
  // ADR-0054 M4-E single config-error contract: a worker DEEP-pass config failure
  // (`config-invalid`) maps to the SAME typed error + exit code (ConfigurationError
  // → CONFIGURATION_ERROR, exit 2) the host COARSE pass throws, so the user sees a
  // consistent "Invalid configuration …" regardless of which pass caught it.
  if (failureClass === 'config-invalid') {
    return new ConfigurationError(message, { code: 'CONFIGURATION_ERROR', failureClass });
  }
  return new SystemError(`external tool '${spec.toolId}' ${label} failed: ${message}`, {
    code: 'SYSTEM.DISPATCH.WORKER_FAILED',
    failureClass,
  });
}

/** Convert a worker `error` IPC message into a logged, structured {@link ToolError}. */
function workerErrorToToolError(spec: ToolCommandWorkerSpec, msg: DispatchWorkerError): ToolError {
  return dispatchError(spec, msg.message, msg.failureClass ?? 'ipc_error');
}
