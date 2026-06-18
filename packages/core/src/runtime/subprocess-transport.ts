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

import { fork } from 'node:child_process';

import { EnvRegistry } from '../lib/env-registry.js';
import { logger } from '../lib/logger.js';
import { correlationToEnv } from '../lib/run-correlation.js';
import { currentScope } from '../lib/run-scope.js';
import { currentTraceparent } from '../lib/telemetry.js';

import { createInProcessTransport } from './in-process-transport.js';

import type {
  ProgressJob,
  ProgressRun,
  SubprocessJobDescriptor,
  WorkerMessage,
} from './progress-transport.js';

/** Governed escape hatch (env-via-registry): force in-process execution. */
const WORKER_ENV = new EnvRegistry([
  {
    canonical: 'OPENSIP_CLI_NO_WORKER',
    coerce: (raw) => raw === '1',
    default: false,
    docs: 'Set to 1 to run a tool engine in the main process instead of a forked worker (debugging / constrained runtimes). The live view may stutter; output is unchanged.',
  },
]);

/** Reconstruct an Error from a worker's `error` message (preserving stack). */
function workerError(message: string, stack?: string): Error {
  const err = new Error(message);
  if (stack !== undefined) err.stack = stack;
  return err;
}

/**
 * Fork `descriptor.command` (the CLI entry) with `descriptor.argv` (a worker
 * subcommand + spec path) and adapt its {@link WorkerMessage} IPC stream to a
 * {@link ProgressRun}. The child's stdout is suppressed (it must not corrupt the
 * parent's Ink frames); stderr is inherited (logs/diagnostics) and the `ipc`
 * channel carries progress/result/error. Buffers events emitted before the
 * renderer subscribes (parity with the in-process transport), and settles
 * `result` exactly once — on a `result`/`error` message, a child `error`, or a
 * premature `exit`. The child is killed on settle so the short-lived CLI exits.
 */
export function createSubprocessProgressRun<TEvent, TResult>(
  descriptor: SubprocessJobDescriptor,
): ProgressRun<TEvent, TResult> {
  let listener: ((event: TEvent) => void) | undefined;
  const buffer: TEvent[] = [];
  const emit = (event: TEvent): void => {
    if (listener) listener(event);
    else buffer.push(event);
  };

  let settle!: { resolve: (value: TResult) => void; reject: (err: Error) => void };
  const result = new Promise<TResult>((resolve, reject) => {
    settle = { resolve, reject };
  });

  // The parent run's correlation join keys, stamped on every `cli.subprocess.*`
  // event so an operator can attribute the forked worker's lifecycle to the run
  // (and the trace, when OTel is on). `runId` is read from the parent scope — it
  // is NOT on `descriptor.correlation` (B1: env-only) and is injected below.
  const runId = currentScope()?.runId;
  const traceId = currentTraceparent();
  // `workerKind` defaults to `'live-engine'` — the only fork-path caller today
  // (graph/fit/sim live runners). An external-tool fork (ADR-0054) would set its
  // own `descriptor.correlation.workerKind`.
  const workerKind = descriptor.correlation?.workerKind ?? 'live-engine';

  // Fold `correlationToEnv(...)` into the child env so the EXISTING spread carries
  // it (M2). `correlationToEnv` emits `OPENSIP_RUN_ID` from the PARENT run id even
  // though `descriptor.correlation` omits `runId` (B1) — the child's pre-action
  // hook reads it env-first and inherits the run. Built only when the descriptor
  // carries correlation; otherwise `{}` (no `OPENSIP_*` keys injected).
  const correlationEnv = descriptor.correlation
    ? correlationToEnv({ runId: runId ?? '', ...descriptor.correlation })
    : {};

  // Correlation is spread LAST and only adds `OPENSIP_*` keys (never the API key,
  // by Task 0.1's guarantee), so `PATH`/`HOME`/`OTEL_*`/`descriptor.env` are all
  // preserved (M2). The child env is built only when there is something to add
  // beyond `process.env` (an `env` override or correlation), else left undefined
  // so `fork` inherits the parent env wholesale.
  const childEnv =
    descriptor.env || descriptor.correlation
      ? { ...process.env, ...descriptor.env, ...correlationEnv }
      : undefined;

  const child = fork(descriptor.command, [...descriptor.argv], {
    // stdout ignored (no child render bytes in the parent's live view); stderr
    // inherited (logs surface); ipc channel for the WorkerMessage protocol.
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    // Structured-clone IPC instead of the default JSON serializer: progress
    // events and tool results stay safe even if a payload grows a Map/Set/Date
    // (the JSON serializer would silently drop or mangle those). Workers send
    // slim, plain-data results today; this keeps the transport robust regardless.
    serialization: 'advanced',
    // @fitness-ignore-next-line env-secret-exposure -- fork() REPLACES the child env wholesale when `env` is set, so the parent env must be spread in to preserve it; correlation env carries NO secret (Task 0.1) and this object is passed to fork, never logged.
    ...(childEnv === undefined ? {} : { env: childEnv }),
  });

  // `cli.subprocess.spawn` (Event Catalog): the parent records that it forked a
  // worker, keyed by `runId`/`traceId`/`workerKind`/`command`, so an operator can
  // pivot from a child log line back to this fork.
  logger.info({
    evt: 'cli.subprocess.spawn',
    module: 'core:subprocess-transport',
    ...(runId === undefined ? {} : { runId }),
    ...(traceId === undefined ? {} : { traceId }),
    workerKind,
    command: descriptor.command,
  });

  let settled = false;
  const done = (apply: () => void): void => {
    if (settled) return;
    settled = true;
    apply();
    child.kill();
  };

  // Log a structured `cli.subprocess.failed` (Event Catalog) attributing the
  // worker failure to its run. `failureClass` falls back to `'ipc_error'` for an
  // `error` IPC message and `'exit_nonzero'` for a premature `exit`.
  const logFailed = (failureClass: string, msg?: WorkerMessage<TEvent, TResult>): void => {
    logger.error({
      evt: 'cli.subprocess.failed',
      module: 'core:subprocess-transport',
      ...(runId === undefined ? {} : { runId }),
      ...(traceId === undefined ? {} : { traceId }),
      // Prefer the worker-reported kind/workerKind from the error payload; else
      // the descriptor's kind. The error payload carries no `runId` (B1).
      workerKind: (msg?.kind === 'error' ? msg.correlation?.workerKind : undefined) ?? workerKind,
      failureClass: (msg?.kind === 'error' ? msg.failureClass : undefined) ?? failureClass,
    });
  };

  child.on('message', (msg: WorkerMessage<TEvent, TResult>) => {
    if (msg.kind === 'progress') emit(msg.event);
    else if (msg.kind === 'result') {
      // GAP-b: exactly ONE run-level completion per forked worker — the PARENT
      // owns it. The forked worker emits its own worker-scoped `*.worker.complete`
      // (distinguished by `workerKind`), so the parent must NOT duplicate a
      // generic run-level `complete` under the inherited `runId`. This is the only
      // parent-side completion, in the `result`-success branch alone.
      done(() => {
        logger.info({
          evt: 'cli.subprocess.complete',
          module: 'core:subprocess-transport',
          ...(runId === undefined ? {} : { runId }),
          ...(traceId === undefined ? {} : { traceId }),
          workerKind,
        });
        settle.resolve(msg.value);
      });
    } else
      done(() => {
        logFailed('ipc_error', msg);
        settle.reject(workerError(msg.message, msg.stack));
      });
  });
  child.on('error', (err: Error) =>
    done(() => {
      logFailed('spawn');
      settle.reject(err);
    }),
  );
  child.on('exit', (code: number | null) => {
    done(() => {
      logFailed('exit_nonzero');
      settle.reject(new Error(`worker exited (code ${code ?? 'null'}) before producing a result`));
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
      // The child could not be forked — degrade to in-process so the run still
      // completes (the live view may stutter; output is unchanged). Log the
      // degradation so it is observable rather than a silent swallow.
      logger.warn({
        evt: 'transport.worker.fork_failed',
        module: 'core:subprocess-transport',
        command: opts.descriptor.command,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return createInProcessTransport().run<TEvent, TResult>(opts.inProcess);
}
