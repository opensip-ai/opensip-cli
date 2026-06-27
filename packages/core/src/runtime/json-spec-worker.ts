import { readFileSync } from 'node:fs';

import { getWorkerErrorFailureClass } from './worker-error-failure-class.js';
import { sendWorkerIpcMessage } from './worker-ipc-send.js';
import { startWorkerHeartbeat } from './worker-heartbeat.js';

import type { WorkerMessage } from './progress-transport.js';

type WorkerEmit<TEvent> = (event: TEvent) => void;

export interface JsonSpecWorkerOptions<TArgs, TEvent, TResult> {
  readonly specPath: string;
  readonly startEvent?: TEvent;
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

export async function runJsonSpecWorker<TArgs, TEvent, TResult>(
  options: JsonSpecWorkerOptions<TArgs, TEvent, TResult>,
): Promise<void> {
  const stopHeartbeat = startWorkerHeartbeat();
  try {
    const args = readJsonSpec<TArgs>(options.specPath);
    const emit: WorkerEmit<TEvent> = (event) =>
      sendWorkerIpcMessage({ kind: 'progress', event } satisfies WorkerMessage<TEvent, TResult>);
    if (options.startEvent !== undefined) emit(options.startEvent);
    sendWorkerIpcMessage({
      kind: 'result',
      value: await options.run(args, emit),
    } satisfies WorkerMessage<TEvent, TResult>);
  } catch (error) {
    sendWorkerIpcMessage(toWorkerErrorMessage<TEvent, TResult>(error));
  } finally {
    stopHeartbeat();
  }
}
