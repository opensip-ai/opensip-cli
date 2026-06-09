/**
 * Worker-thread ProgressTransport (ADR-0028) — runs a tool's engine OFF the main
 * thread and relays its progress back to the main-thread renderer, so the Ink
 * reconciler + the 80ms live-progress clock never block on a synchronous CPU
 * blast (AST walks, rule passes, the TS type-checker). This is the off-process
 * variant `progress-transport.ts` always described but never implemented.
 *
 * Unlike the in-process transport, the worker cannot receive a closure — it gets
 * a {@link WorkerJobDescriptor} (a worker entry module URL + structured-clone-safe
 * `workerData`). The worker entry runs the engine and posts {@link WorkerMessage}s;
 * this host maps them to the same {@link ProgressRun} contract the renderer
 * consumes, so the renderer is agnostic to which transport ran.
 *
 * Generic over `TEvent`/`TResult`: core never names cli-ui's `ProgressEvent`.
 */

import { Worker } from 'node:worker_threads';

import { EnvRegistry } from '../lib/env-registry.js';

import { createInProcessTransport } from './in-process-transport.js';

import type {
  ProgressJob,
  ProgressRun,
  WorkerJobDescriptor,
  WorkerMessage,
} from './progress-transport.js';

/** Governed escape hatch (env-via-registry): force in-process execution. */
const WORKER_ENV = new EnvRegistry([
  {
    canonical: 'OPENSIP_TOOLS_NO_WORKER',
    coerce: (raw) => raw === '1',
    default: false,
    docs: 'Set to 1 to run a tool engine in-process instead of a worker thread (debugging / constrained runtimes). The live view may stutter; output is unchanged.',
  },
]);

/** Reconstruct an Error from a worker's `error` message (preserving stack). */
function workerError(message: string, stack?: string): Error {
  const err = new Error(message);
  if (stack !== undefined) err.stack = stack;
  return err;
}

/**
 * Spawn `descriptor.workerUrl` in a worker thread and adapt its
 * {@link WorkerMessage} stream to a {@link ProgressRun}. Buffers events emitted
 * before the renderer subscribes (parity with the in-process transport), and
 * always settles `result` exactly once — on a `result` message, an `error`
 * message, a worker `error`, or a premature `exit`. The worker is terminated on
 * settle so the short-lived CLI can exit cleanly.
 */
export function createWorkerProgressRun<TEvent, TResult>(
  descriptor: WorkerJobDescriptor,
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

  const worker = new Worker(descriptor.workerUrl, { workerData: descriptor.workerData });
  let settled = false;
  const done = (apply: () => void): void => {
    if (settled) return;
    settled = true;
    apply();
    void worker.terminate();
  };

  worker.on('message', (msg: WorkerMessage<TEvent, TResult>) => {
    if (msg.kind === 'progress') emit(msg.event);
    else if (msg.kind === 'result') done(() => settle.resolve(msg.value));
    else done(() => settle.reject(workerError(msg.message, msg.stack)));
  });
  worker.on('error', (err: Error) => done(() => settle.reject(err)));
  worker.on('exit', (code: number) => {
    done(() => settle.reject(new Error(`worker exited (code ${code}) before producing a result`)));
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
 * Run work off the main thread when possible, else in-process — with an identical
 * {@link ProgressRun} either way, so the renderer doesn't care which ran. The
 * caller supplies BOTH a worker {@link WorkerJobDescriptor} and the equivalent
 * in-process {@link ProgressJob} (the same work as a local closure). Worker is
 * preferred unless `preferWorker: false` or `OPENSIP_TOOLS_NO_WORKER=1`, and a
 * synchronous worker-construction failure degrades to in-process.
 */
export function runOffThreadOrInProcess<TEvent, TResult>(opts: {
  readonly descriptor: WorkerJobDescriptor;
  readonly inProcess: ProgressJob<TEvent, TResult>;
  readonly preferWorker?: boolean;
}): ProgressRun<TEvent, TResult> {
  const envDisablesWorker = WORKER_ENV.get<boolean>('OPENSIP_TOOLS_NO_WORKER') === true;
  const preferWorker = (opts.preferWorker ?? true) && !envDisablesWorker;
  if (preferWorker) {
    try {
      return createWorkerProgressRun<TEvent, TResult>(opts.descriptor);
    } catch {
      // The worker could not be constructed (e.g. a runtime without
      // worker_threads) — fall through to in-process so the run still completes.
    }
  }
  return createInProcessTransport().run<TEvent, TResult>(opts.inProcess);
}
