/**
 * dispatch-external-tool-command — the HOST supervisor for the out-of-process
 * external tool command dispatch plane (ADR-0054, increment M4-D vertical
 * slice).
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
 *   3. on success, replays the slim {@link ToolCommandResult} through the REAL
 *      host {@link ToolCliContext} seams (`render` / `emitEnvelope` / `emitJson`
 *      / `emitRaw` / `emitError` / `setExitCode`) so the host remains the only
 *      process that performs the privileged effect and the output contract stays
 *      byte-identical to the in-process path.
 *
 * Bundled first-party tools never reach here — they stay in-process (the trusted
 * computing base). External tools have NO in-process fallback by trust tier
 * (ADR-0054): a fork failure is a hard, structured error, not a silent in-host
 * run.
 */

import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  currentScope,
  SystemError,
  type ToolError,
  type ToolCliContext,
  type ToolProvenance,
  type ToolSource,
  type WorkerMessage,
} from '@opensip-cli/core';

import { BOOTSTRAP_MODULE } from './constants.js';

import type { ToolCommandResult, ToolCommandWorkerSpec } from './tool-command-dispatch-types.js';

/** Default supervisor wall-clock timeout for one dispatched command (ms). */
const DEFAULT_DISPATCH_TIMEOUT_MS = 120_000;

/** The built worker entry module the supervisor forks (sibling of this file in dist/). */
const WORKER_ENTRY = fileURLToPath(new URL('tool-command-worker-entry.js', import.meta.url));

/** Narrowing helper: a worker `error` IPC message carries an optional failureClass/stack. */
type DispatchWorkerError = Extract<WorkerMessage<never, ToolCommandResult>, { kind: 'error' }>;

export interface DispatchExternalToolCommandArgs {
  /** The external tool's provenance (source must NOT be `'bundled'`). */
  readonly provenance: ToolProvenance;
  /** Which command (by `CommandSpec.name`) to run in the worker. */
  readonly commandName: string;
  /** Parsed opts for this invocation (serializable). */
  readonly opts: Record<string, unknown>;
  /** Trailing positionals (`_args`) for this invocation (serializable). */
  readonly positionals: readonly unknown[];
  /** The real host context the supervisor replays the worker result through. */
  readonly ctx: ToolCliContext;
  /** Override the wall-clock timeout (tests use a short one). */
  readonly timeoutMs?: number;
  /** Override the worker entry module path (tests fork a fixture). */
  readonly workerEntry?: string;
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

  const result = await runWorker(args);
  await replayResult(result, args.ctx);
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
  };

  const dir = mkdtempSync(join(tmpdir(), 'opensip-tool-dispatch-'));
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(spec), 'utf8');

  const entry = args.workerEntry ?? WORKER_ENTRY;
  const timeoutMs = args.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;

  try {
    return await forkAndAwait(entry, specPath, spec, timeoutMs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The low-level fork + IPC settle. Mirrors the shared subprocess transport's
 * single-settle / kill-on-settle discipline, but adds a supervisor timeout and
 * binds the COMMAND result/error shapes. Kept self-contained (not routed through
 * `createSubprocessProgressRun`) because this path needs no progress fan-out and
 * does need an owned timeout + correlation env injection symmetric to the
 * transport.
 */
function forkAndAwait(
  entry: string,
  specPath: string,
  spec: ToolCommandWorkerSpec,
  timeoutMs: number,
): Promise<ToolCommandResult> {
  return new Promise<ToolCommandResult>((resolve, reject) => {
    const runId = currentScope()?.runId;
    const childEnv =
      runId === undefined || runId.length === 0
        ? undefined
        : // @fitness-ignore-next-line env-secret-exposure -- fork() with an `env` set REPLACES the child env wholesale, so the parent env must be spread in to preserve PATH/HOME/etc.; only OPENSIP_RUN_ID (no secret) is added, and this object is passed to fork, never logged (parity with subprocess-transport's childEnv).
          { ...process.env, OPENSIP_RUN_ID: runId };

    const child = fork(entry, [specPath], {
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

    child.on('message', (msg: WorkerMessage<never, ToolCommandResult>) => {
      if (msg.kind === 'result') {
        done(() => {
          resolve(msg.value);
        });
      } else if (msg.kind === 'error') {
        done(() => {
          reject(workerErrorToToolError(spec, msg));
        });
      }
      // `progress` is unused in the dispatch slice; ignore defensively.
    });
    child.on('error', (err: Error) => {
      done(() => {
        reject(dispatchError(spec, `worker failed to spawn: ${err.message}`, 'spawn'));
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
  return new SystemError(
    `external tool '${spec.toolId}' command '${spec.commandName}' failed: ${message}`,
    { code: 'SYSTEM.DISPATCH.WORKER_FAILED', failureClass },
  );
}

/** Convert a worker `error` IPC message into a logged, structured {@link ToolError}. */
function workerErrorToToolError(spec: ToolCommandWorkerSpec, msg: DispatchWorkerError): ToolError {
  return dispatchError(spec, msg.message, msg.failureClass ?? 'ipc_error');
}

/**
 * Replay the worker's slim {@link ToolCommandResult} through the REAL host
 * {@link ToolCliContext} seams. The host is the only process that performs the
 * privileged effect (render / stdout / exit code). Each final-result-return seam
 * the worker recorded is replayed through its host counterpart; the exit code is
 * applied LAST so it is the final word (matching the in-process dispatch path's
 * `setExitCode` semantics).
 */
async function replayResult(result: ToolCommandResult, ctx: ToolCliContext): Promise<void> {
  if (result.error !== undefined) {
    ctx.emitError(result.error);
  }
  if (result.render !== undefined) {
    await ctx.render(result.render);
  }
  if (result.envelope !== undefined) {
    ctx.emitEnvelope(result.envelope);
  }
  if (result.json !== undefined) {
    ctx.emitJson(result.json);
  }
  if (result.raw !== undefined) {
    ctx.emitRaw(result.raw);
  }
  if (result.exitCode !== undefined) {
    ctx.setExitCode(result.exitCode);
  }
}
