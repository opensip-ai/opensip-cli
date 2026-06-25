/**
 * Subprocess ProgressTransport (ADR-0028) — runs a tool's engine in a forked
 * child process and relays its progress back to the main-process renderer, so
 * the Ink reconciler + the 80ms live-progress clock never block on a synchronous
 * CPU blast (AST walks, rule passes, the TS type-checker). This is the
 * off-process variant `progress-transport.ts` always described.
 *
 * Why a child PROCESS, not a worker thread: the engine reads `currentScope()`
 * (the language + tool registries, project, config), which only the CLI bootstrap
 * populates — and a worker thread in an engine package can't re-run that bootstrap
 * (layering) without a partial registry that would diverge a polyglot run's
 * results. A forked CLI subcommand re-bootstraps the whole scope for free (the
 * pattern graph's shard workers already use). The boundary is IPC JSON only.
 *
 * Generic over `TEvent`/`TResult`: core never names cli-ui's `ProgressEvent`.
 */

import { EnvRegistry } from '../lib/env-registry.js';
import { correlationToEnv } from '../lib/run-correlation.js';
import { currentLogger, currentScope } from '../lib/run-scope.js';
import { currentTraceparent } from '../lib/telemetry.js';

import { forkAndSettle } from './fork-and-settle.js';
import { createInProcessTransport } from './in-process-transport.js';

import type {
  ProgressJob,
  ProgressRun,
  SubprocessJobDescriptor,
  WorkerMessage,
} from './progress-transport.js';

/**
 * Governed escape hatch (env-via-registry): force in-process execution.
 *
 * ADR-0054 M4-E trust tier: this fallback is BUNDLED-ONLY. It applies to
 * first-party (trusted-computing-base) engine forks routed through
 * {@link runOffThreadOrInProcess} (graph/fit/sim live engines). It NEVER applies
 * to EXTERNAL tool command dispatch — an external tool always forks the worker
 * (the dispatch supervisor has no in-process fallback by trust tier; a fork
 * failure is a hard error there, not a degrade-to-in-host).
 */
const WORKER_ENV = new EnvRegistry([
  {
    canonical: 'OPENSIP_CLI_NO_WORKER',
    coerce: (raw) => raw === '1',
    default: false,
    docs: 'Set to 1 to run a BUNDLED tool engine in the main process instead of a forked worker (debugging / constrained runtimes). The live view may stutter; output is unchanged. Bundled-only (ADR-0054 trust tier): external tools always fork — this flag never makes an external tool run in-host.',
  },
]);

/** Reconstruct an Error from a worker's `error` message (preserving stack). */
function workerError(message: string, stack?: string, stderrTail?: string): Error {
  const err = new Error(message) as Error & { stderrTail?: string };
  if (stack !== undefined) err.stack = stack;
  if (stderrTail !== undefined) err.stderrTail = stderrTail;
  return err;
}

/**
 * Fork `descriptor.command` (the CLI entry) with `descriptor.argv` (a worker
 * subcommand + spec path) and adapt its {@link WorkerMessage} IPC stream to a
 * {@link ProgressRun}. The child's stdout is suppressed (it must not corrupt the
 * parent's Ink frames); stderr is captured (size-capped) unless the inherit
 * hatch is set; the `ipc` channel carries progress/result/error. Buffers events
 * emitted before the renderer subscribes (parity with the in-process transport),
 * and settles `result` exactly once — on a `result`/`error` message, a child
 * `error`, or a premature `exit`. The child tree is killed on settle.
 */
export function createSubprocessProgressRun<TEvent, TResult>(
  descriptor: SubprocessJobDescriptor,
): ProgressRun<TEvent, TResult> {
  let listener: ((event: TEvent) => void) | undefined;
  const buffer: TEvent[] = [];
  const emit = (event: TEvent): void => {
    if (listener) listener(event);
    // @fitness-ignore-next-line stream-buffer-size-limits -- bounded by design: a transient PRE-SUBSCRIBE buffer drained on the first onProgress (the `while (buffer.length > 0)` flush below), identical to in-process-transport; the bounded `.length`-guard marker just drifted past the check's 50-line proximity window when the correlation block landed between push and flush.
    else buffer.push(event);
  };

  let settle!: {
    resolve: (value: TResult) => void;
    reject: (err: Error) => void;
  };
  const result = new Promise<TResult>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const runId = currentScope()?.runId;
  const traceId = currentTraceparent();
  const runLogger = currentLogger();
  const workerKind = descriptor.correlation?.workerKind ?? 'live-engine';

  const diagnostics = currentScope()?.diagnostics;
  const subprocessCorrelation = {
    ...(runId === undefined ? {} : { runId }),
    ...(traceId === undefined ? {} : { traceId }),
    ...(descriptor.correlation?.tool === undefined ? {} : { tool: descriptor.correlation.tool }),
    ...(descriptor.correlation?.parentCommand === undefined
      ? {}
      : { parentCommand: descriptor.correlation.parentCommand }),
    workerKind,
  };

  const correlationEnv = descriptor.correlation
    ? correlationToEnv({ runId: runId ?? '', ...descriptor.correlation })
    : {};

  runLogger.info({
    evt: 'cli.subprocess.spawn',
    module: 'core:subprocess-transport',
    ...(runId === undefined ? {} : { runId }),
    ...(traceId === undefined ? {} : { traceId }),
    workerKind,
    command: descriptor.command,
  });
  diagnostics?.emitSubprocessEvent('load', 'debug', 'subprocess.spawn', subprocessCorrelation, {
    command: descriptor.command,
  });

  const logFailed = (failureClass: string, msg?: WorkerMessage<TEvent, TResult>): void => {
    const resolvedWorkerKind =
      (msg?.kind === 'error' ? msg.correlation?.workerKind : undefined) ?? workerKind;
    const resolvedFailureClass =
      (msg?.kind === 'error' ? msg.failureClass : undefined) ?? failureClass;
    runLogger.error({
      evt: 'cli.subprocess.failed',
      module: 'core:subprocess-transport',
      ...(runId === undefined ? {} : { runId }),
      ...(traceId === undefined ? {} : { traceId }),
      workerKind: resolvedWorkerKind,
      failureClass: resolvedFailureClass,
    });
    diagnostics?.emitSubprocessEvent(
      'load',
      'warn',
      'subprocess.failed',
      { ...subprocessCorrelation, workerKind: resolvedWorkerKind },
      { failureClass: resolvedFailureClass },
    );
  };

  const handle = forkAndSettle(
    {
      command: descriptor.command,
      argv: descriptor.argv,
      enableHeartbeat: true,
      enableSigintCancellation: true,
      buildChildEnv: (parentEnv) => {
        const traceparentEnv = traceId === undefined ? {} : { TRACEPARENT: traceId };
        if (descriptor.env || descriptor.correlation || traceId !== undefined) {
          // @fitness-ignore-next-line env-secret-exposure -- fork() REPLACES the child env wholesale when `env` is set, so the parent env must be spread in to preserve it; correlation env carries NO secret (Task 0.1) and this object is passed to fork, never logged.
          return {
            ...parentEnv,
            ...descriptor.env,
            ...correlationEnv,
            ...traceparentEnv,
          };
        }
        return parentEnv;
      },
      onMessage: (msg: unknown) => {
        const typed = msg as WorkerMessage<TEvent, TResult>;
        if (typed.kind === 'progress') emit(typed.event);
        else if (typed.kind === 'result') {
          handle.done(() => {
            runLogger.info({
              evt: 'cli.subprocess.complete',
              module: 'core:subprocess-transport',
              ...(runId === undefined ? {} : { runId }),
              ...(traceId === undefined ? {} : { traceId }),
              workerKind,
            });
            diagnostics?.emitSubprocessEvent(
              'load',
              'debug',
              'subprocess.complete',
              subprocessCorrelation,
            );
            settle.resolve(typed.value);
          });
        } else if (typed.kind === 'error') {
          handle.done(() => {
            logFailed('ipc_error', typed);
            settle.reject(workerError(typed.message, typed.stack, handle.getStderrTail()));
          });
        }
      },
      onLimitFailure: (failureClass, detail) => {
        logFailed(failureClass);
        const msg =
          detail === undefined
            ? `worker failed: ${failureClass}`
            : `worker failed: ${failureClass} (${detail})`;
        settle.reject(workerError(msg, undefined, handle.getStderrTail()));
      },
    },
    { runId },
  );

  handle.child.on('exit', (code: number | null) => {
    if (handle.isSettled()) return;
    handle.done(() => {
      logFailed('exit_nonzero');
      settle.reject(
        workerError(
          `worker exited (code ${code ?? 'null'}) before producing a result`,
          undefined,
          handle.getStderrTail(),
        ),
      );
    });
  });

  return {
    onProgress(next: (event: TEvent) => void): void {
      listener = next;
      while (buffer.length > 0) {
        const event = buffer.shift();
        if (event !== undefined) next(event);
      }
    },
    result,
  };
}

/**
 * Run work off the main process when possible, else in-process — with an
 * identical {@link ProgressRun} either way, so the renderer doesn't care which
 * ran. The caller supplies BOTH a {@link SubprocessJobDescriptor} (the forked
 * worker) and the equivalent in-process {@link ProgressJob} (the same work as a
 * local closure). Subprocess is preferred unless `preferWorker: false` or
 * `OPENSIP_CLI_NO_WORKER=1`, and a synchronous fork failure degrades to
 * in-process.
 */
export function runOffThreadOrInProcess<TEvent, TResult>(opts: {
  readonly descriptor: SubprocessJobDescriptor;
  readonly inProcess: ProgressJob<TEvent, TResult>;
  readonly preferWorker?: boolean;
}): ProgressRun<TEvent, TResult> {
  const envDisablesWorker = WORKER_ENV.get<boolean>('OPENSIP_CLI_NO_WORKER') === true;
  const preferWorker = (opts.preferWorker ?? true) && !envDisablesWorker;
  if (preferWorker) {
    try {
      return createSubprocessProgressRun<TEvent, TResult>(opts.descriptor);
    } catch (error) {
      currentLogger().warn({
        evt: 'transport.worker.fork_failed',
        module: 'core:subprocess-transport',
        command: opts.descriptor.command,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return createInProcessTransport().run<TEvent, TResult>(opts.inProcess);
}
