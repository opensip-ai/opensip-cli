import { readFileSync } from 'node:fs';

import { toWorkerFailureWire, WORKER_FAILURE_WIRE_VERSION } from './worker-failure-wire.js';
import { startWorkerHeartbeat } from './worker-heartbeat.js';
import { sendWorkerIpcMessage, sendWorkerIpcMessageAndDrain } from './worker-ipc-send.js';

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
  const wire = toWorkerFailureWire(error);
  return {
    kind: 'error',
    message: wire.message,
    // Stack is operator-only: omit from wire (Plan 00). Parent uses failure projection.
    ...(wire.failureClass === undefined ? {} : { failureClass: wire.failureClass }),
    ...(wire.code === undefined ? {} : { code: wire.code }),
    ...(wire.detailCode === undefined ? {} : { detailCode: wire.detailCode }),
    ...(wire.failure === undefined
      ? {}
      : { failure: wire.failure, failureWireVersion: WORKER_FAILURE_WIRE_VERSION }),
  };
}

function sendJsonSpecWorkerMessage<TEvent, TResult>(msg: WorkerMessage<TEvent, TResult>): void {
  sendWorkerIpcMessage(msg);
}

async function sendJsonSpecWorkerTerminalMessage<TEvent, TResult>(
  msg: WorkerMessage<TEvent, TResult>,
): Promise<void> {
  // Final result/error must drain so the parent observes the message before exit.
  await sendWorkerIpcMessageAndDrain(msg);
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
    await sendJsonSpecWorkerTerminalMessage({
      kind: 'result',
      value: await options.run(args, emit),
    } satisfies WorkerMessage<TEvent, TResult>);
  } catch (error) {
    await sendJsonSpecWorkerTerminalMessage(toWorkerErrorMessage<TEvent, TResult>(error));
  } finally {
    stopJsonSpecWorkerHeartbeat(stopHeartbeat);
  }
}
