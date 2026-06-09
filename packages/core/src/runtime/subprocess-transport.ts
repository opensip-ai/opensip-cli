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
    canonical: 'OPENSIP_TOOLS_NO_WORKER',
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

  const child = fork(descriptor.command, [...descriptor.argv], {
    // stdout ignored (no child render bytes in the parent's live view); stderr
    // inherited (logs surface); ipc channel for the WorkerMessage protocol.
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    // Structured-clone IPC instead of the default JSON serializer: progress
    // events and tool results stay safe even if a payload grows a Map/Set/Date
    // (the JSON serializer would silently drop or mangle those). Workers send
    // slim, plain-data results today; this keeps the transport robust regardless.
    serialization: 'advanced',
    ...(descriptor.env === undefined ? {} : { env: { ...process.env, ...descriptor.env } }),
  });

  let settled = false;
  const done = (apply: () => void): void => {
    if (settled) return;
    settled = true;
    apply();
    child.kill();
  };

  child.on('message', (msg: WorkerMessage<TEvent, TResult>) => {
    if (msg.kind === 'progress') emit(msg.event);
    else if (msg.kind === 'result') done(() => settle.resolve(msg.value));
    else done(() => settle.reject(workerError(msg.message, msg.stack)));
  });
  child.on('error', (err: Error) => done(() => settle.reject(err)));
  child.on('exit', (code: number | null) => {
    done(() => settle.reject(new Error(`worker exited (code ${code ?? 'null'}) before producing a result`)));
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
 * `OPENSIP_TOOLS_NO_WORKER=1`, and a synchronous fork failure degrades to
 * in-process.
 */
export function runOffThreadOrInProcess<TEvent, TResult>(opts: {
  readonly descriptor: SubprocessJobDescriptor;
  readonly inProcess: ProgressJob<TEvent, TResult>;
  readonly preferWorker?: boolean;
}): ProgressRun<TEvent, TResult> {
  const envDisablesWorker = WORKER_ENV.get<boolean>('OPENSIP_TOOLS_NO_WORKER') === true;
  const preferWorker = (opts.preferWorker ?? true) && !envDisablesWorker;
  if (preferWorker) {
    try {
      return createSubprocessProgressRun<TEvent, TResult>(opts.descriptor);
    } catch {
      // The child could not be forked — fall through to in-process so the run
      // still completes (the live view may stutter; output is unchanged).
    }
  }
  return createInProcessTransport().run<TEvent, TResult>(opts.inProcess);
}
