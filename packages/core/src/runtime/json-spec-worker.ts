import { readFileSync } from 'node:fs';

import { getWorkerErrorFailureClass } from './worker-error-failure-class.js';
import { startWorkerHeartbeat } from './worker-heartbeat.js';
import { sendWorkerIpcMessage } from './worker-ipc-send.js';

import type { WorkerMessage } from './progress-transport.js';

type WorkerEmit<TEvent> = (event: TEvent) => void;

/**
 * Inputs for a JSON-spec worker entrypoint that reads one serialized spec file,
 * emits progress events over worker IPC, and sends back one final result.
 */
export interface JsonSpecWorkerOptions<TArgs, TEvent, TResult> {
  /** Path to the JSON file containing the worker arguments. */
  readonly specPath: string;
  /** Optional progress event emitted before the worker's run function starts. */
  readonly startEvent?: TEvent;
  /** Worker body that receives parsed args plus an IPC progress emitter. */
  readonly run: (args: TArgs, emit: WorkerEmit<TEvent>) => Promise<TResult>;
}

function readJsonSpec<TArgs>(specPath: string): TArgs {
  return JSON.parse(readFileSync(specPath, 'utf8')) as TArgs;
}

function toWorkerErrorMessage<TEvent, TResult>(error: unknown): WorkerMessage<TEvent, TResult> {
  const failureClass = getWorkerErrorFailureClass(error);
  return {
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    ...(failureClass === undefined ? {} : { failureClass }),
  };
}

function sendJsonSpecWorkerMessage<TEvent, TResult>(msg: WorkerMessage<TEvent, TResult>): void {
  sendWorkerIpcMessage(msg);
}

function stopJsonSpecWorkerHeartbeat(stopHeartbeat: () => void): void {
  stopHeartbeat();
}

/**
 * Execute a worker from a JSON spec file and communicate only through the shared
 * `WorkerMessage` IPC protocol used by off-thread live runs.
 */
export async function runJsonSpecWorker<TArgs, TEvent, TResult>(
  options: JsonSpecWorkerOptions<TArgs, TEvent, TResult>,
): Promise<void> {
  const stopHeartbeat = startWorkerHeartbeat();
  try {
    const args = readJsonSpec<TArgs>(options.specPath);
    const emit: WorkerEmit<TEvent> = (event) =>
      sendJsonSpecWorkerMessage({
        kind: 'progress',
        event,
      } satisfies WorkerMessage<TEvent, TResult>);
    if (options.startEvent !== undefined) emit(options.startEvent);
    sendJsonSpecWorkerMessage({
      kind: 'result',
      value: await options.run(args, emit),
    } satisfies WorkerMessage<TEvent, TResult>);
  } catch (error) {
    sendJsonSpecWorkerMessage(toWorkerErrorMessage<TEvent, TResult>(error));
  } finally {
    stopJsonSpecWorkerHeartbeat(stopHeartbeat);
  }
}
