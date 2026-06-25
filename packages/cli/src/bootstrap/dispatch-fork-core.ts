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

import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigurationError,
  currentScope,
  currentTraceparent,
  forkAndSettle,
  getWorkerLimits,
  SystemError,
  type ToolError,
  type ToolProvenance,
  type WorkerMessage,
} from '@opensip-cli/core';

import { buildExternalWorkerChildEnv } from './build-external-worker-child-env.js';
import { BOOTSTRAP_MODULE } from './constants.js';
import { handleHostRpc } from './dispatch-host-rpc-handler.js';
import { type DispatchHostCtx } from './dispatch-replay-result.js';

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
 * The low-level fork + IPC settle. Uses the shared {@link forkAndSettle}
 * primitive for resource ceilings + tree-kill, while keeping the RPC-reply
 * direction (`child.send`) in this dispatch supervisor.
 *
 * The wall-clock timeout is a HARD cap on the WHOLE run (resource control,
 * ADR-0054 Consequences) — it is deliberately NOT reset on each RPC, so a runaway
 * upcall loop is still killed rather than extending the budget indefinitely. An
 * optional per-upcall idle timer (`OPENSIP_CLI_WORKER_IDLE_RPC_MS`) is off by
 * default and does NOT extend the per-run cap.
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
    const traceparent = currentTraceparent();
    let inFlightRpc = 0;
    let totalRpc = 0;

    const handle = forkAndSettle(
      {
        command: cliScript,
        argv: [WORKER_SUBCOMMAND, specPath, '--cwd', cwd],
        cwd,
        timeoutMs,
        enableHeartbeat: true,
        enableSigintCancellation: true,
        buildChildEnv: (parentEnv) =>
          buildExternalWorkerChildEnv({ parentEnv, runId, traceparent }),
        onMessage: (msg: unknown) => {
          const typed = msg as DispatchWorkerMessage;
          if (typed.kind === 'progress') {
            serveRpc(typed.event);
          } else if (typed.kind === 'result') {
            handle.done(() => {
              resolve(typed.value);
            });
          } else if (typed.kind === 'error') {
            handle.done(() => {
              reject(workerErrorToToolError(spec, typed, handle.getStderrTail()));
            });
          }
        },
        onLimitFailure: (failureClass, detail) => {
          reject(
            dispatchError(
              spec,
              detail === undefined
                ? `worker failed: ${failureClass}`
                : `worker failed: ${failureClass} (${detail})`,
              failureClass,
              handle.getStderrTail(),
            ),
          );
        },
      },
      { runId },
    );

    const serveRpc = (request: HostRpcRequest): void => {
      const workerLimits = getWorkerLimits();
      totalRpc += 1;
      if (totalRpc > workerLimits.maxTotalRpc) {
        handle.killTree('SIGKILL');
        handle.done(() => {
          reject(dispatchError(spec, 'host-RPC upcall flood (total cap exceeded)', 'rpc_flood'));
        });
        return;
      }
      if (inFlightRpc >= workerLimits.maxConcurrentRpc) {
        handle.killTree('SIGKILL');
        handle.done(() => {
          reject(
            dispatchError(spec, 'host-RPC upcall flood (concurrency cap exceeded)', 'rpc_flood'),
          );
        });
        return;
      }
      inFlightRpc += 1;
      void handleHostRpc(request, ctx)
        .then((reply: RpcReply) => {
          inFlightRpc -= 1;
          if (!handle.isSettled()) sendRpcReply(handle.child, reply, spec);
        })
        .catch(() => {
          inFlightRpc -= 1;
        });
    };

    /* v8 ignore next 16 -- defensive isolation-safety arm: `child.on('error')` fires only on a node-executable SPAWN failure (ENOENT on the runtime, EACCES), which is only reachable via impractical fault injection — node always exists in a normal run, so a bad worker entry surfaces via `child.on('exit')` (the covered sibling arm) instead. ADR-0054 trust tier: an external tool that cannot fork is a HARD error, NEVER an in-host fallback (that would run untrusted code in the kernel process). A future explicitly-named developer override (OPENSIP_CLI_DANGEROUSLY_RUN_EXTERNAL_IN_HOST) is reserved, not built. */
    handle.child.on('error', (err: Error) => {
      handle.done(() => {
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
    handle.child.on('exit', (code: number | null) => {
      if (handle.isSettled()) return;
      handle.done(() => {
        reject(
          dispatchError(
            spec,
            `worker exited (code ${code ?? 'null'}) before producing a result`,
            'exit_nonzero',
            handle.getStderrTail(),
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
  stderrTail?: string,
): ToolError {
  const label = specLabel(spec);
  currentScope()?.logger.error({
    evt: 'cli.tool.dispatch_failed',
    module: BOOTSTRAP_MODULE,
    toolId: spec.toolId,
    command: label,
    failureClass,
  });
  if (failureClass === 'config-invalid') {
    return new ConfigurationError(message, {
      code: 'CONFIGURATION_ERROR',
      failureClass,
      stderrTail,
    });
  }
  return new SystemError(`external tool '${spec.toolId}' ${label} failed: ${message}`, {
    code: 'SYSTEM.DISPATCH.WORKER_FAILED',
    failureClass,
    stderrTail,
  });
}

/** Convert a worker `error` IPC message into a logged, structured {@link ToolError}. */
function workerErrorToToolError(
  spec: ToolCommandWorkerSpec,
  msg: DispatchWorkerError,
  stderrTail?: string,
): ToolError {
  return dispatchError(spec, msg.message, msg.failureClass ?? 'ipc_error', stderrTail);
}
