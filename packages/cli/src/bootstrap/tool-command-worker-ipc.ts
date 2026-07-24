/**
 * tool-command-worker-ipc — the worker-side IPC message helpers for the external
 * tool command dispatch plane (ADR-0054). Extracted from
 * `tool-command-worker-entry.ts` so the entry module keeps only the run
 * orchestration: this module owns building/sending the {@link DispatchWorkerMessage}
 * shapes (progress + terminal result/error) and stamping the worker's diagnostics
 * snapshot onto the terminal result (ADR-0174).
 */

import {
  currentScope,
  IpcPayloadTooLargeError,
  sendWorkerIpcMessage,
  sendWorkerIpcMessageAndDrain,
  toWorkerFailureWire,
  WORKER_FAILURE_WIRE_VERSION,
  type WorkerMessage,
} from '@opensip-cli/core';

import type {
  DispatchProgressEvent,
  ToolCommandFailureClass,
  ToolCommandResult,
} from './tool-command-dispatch-types.js';

/**
 * The worker's IPC message type binding: host-RPC requests stream on the
 * `progress` arm; the final {@link ToolCommandResult} settles `result`.
 */
export type DispatchWorkerMessage = WorkerMessage<DispatchProgressEvent, ToolCommandResult>;

/** Post one IPC message to the parent (no-op when not forked — e.g. a unit call). */
export function send(msg: DispatchWorkerMessage): void {
  try {
    sendWorkerIpcMessage(msg);
  } catch (error) {
    if (error instanceof IpcPayloadTooLargeError) {
      process.send?.({ kind: 'error', message: error.message, failureClass: 'payload_too_large' });
      return;
    }
    throw error;
  }
}

/**
 * Terminal IPC send — drains before the worker process exits so the parent does
 * not race `exit` ahead of `message` under load (the 61849de7 race, closed here
 * for the external-tool dispatch path). Progress/host-RPC sends stay synchronous;
 * only the final result/error needs the drain.
 */
export async function sendTerminal(msg: DispatchWorkerMessage): Promise<void> {
  try {
    await sendWorkerIpcMessageAndDrain(msg);
  } catch (error) {
    if (error instanceof IpcPayloadTooLargeError) {
      await sendWorkerIpcMessageAndDrain({
        kind: 'error',
        message: error.message,
        failureClass: 'payload_too_large',
      });
      return;
    }
    throw error;
  }
}

/**
 * Build a structured `error` IPC message with a failure class and Plan 00
 * machine failure projection. `code` carries the canonical exit class while
 * `detailCode` carries the original stable subcode. Raw stacks are not wired
 * (operator-only); parent reconstructs via `failure` projection.
 */
export function errorMessage(
  message: string,
  failureClass: ToolCommandFailureClass,
  _stack?: string,
  code?: string,
  detailCode?: string,
  cause?: unknown,
): DispatchWorkerMessage {
  const wire = toWorkerFailureWire(
    cause ??
      Object.assign(new Error(message), {
        failureClass,
        ...(code === undefined ? {} : { code }),
      }),
  );
  return {
    kind: 'error',
    message: wire.message || message,
    failureClass: (wire.failureClass as ToolCommandFailureClass | undefined) ?? failureClass,
    ...(code === undefined && wire.code === undefined ? {} : { code: code ?? wire.code }),
    ...(detailCode === undefined && wire.detailCode === undefined
      ? {}
      : { detailCode: detailCode ?? wire.detailCode }),
    ...(wire.failure === undefined
      ? {}
      : { failure: wire.failure, failureWireVersion: WORKER_FAILURE_WIRE_VERSION }),
  };
}

/**
 * Attach the worker run's diagnostics snapshot to the terminal result message so
 * the host can fold it into its own bus (ADR-0174): a worker-side capability
 * decision (a domain that routed 0-of-N packs, a denied pack, a foreign-core
 * skip) reaches the operator's `--json` diagnostics instead of dying with the
 * worker. The error IPC arm carries its own structured message/stack; result
 * diagnostics are the observability-critical path.
 */
export function stampWorkerDiagnostics(msg: DispatchWorkerMessage): DispatchWorkerMessage {
  if (msg.kind !== 'result') return msg;
  const diagnostics = currentScope()?.diagnostics.snapshot();
  if (diagnostics === undefined) return msg;
  return { ...msg, value: { ...msg.value, diagnostics } };
}
