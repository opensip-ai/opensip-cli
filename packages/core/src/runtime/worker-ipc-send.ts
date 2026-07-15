/**
 * Worker-side IPC send guard — reject oversize payloads before `process.send` (DD1).
 */

import { isIpcPayloadTooLarge, measureIpcPayloadBytes } from './ipc-payload.js';
import { getWorkerLimits } from './worker-limits.js';

/** Error thrown before a worker sends an IPC payload over the configured size cap. */
export class IpcPayloadTooLargeError extends Error {
  readonly failureClass = 'payload_too_large' as const;
  constructor(bytes: number, maxBytes: number) {
    super(`worker IPC payload too large (${String(bytes)} > ${String(maxBytes)} bytes)`);
    this.name = 'IpcPayloadTooLargeError';
  }
}

/**
 * @throws {IpcPayloadTooLargeError} When the serialized message exceeds the cap.
 */
function assertUnderCap(msg: unknown, maxBytes?: number): number {
  const cap = maxBytes ?? getWorkerLimits().maxIpcBytes;
  if (isIpcPayloadTooLarge(msg, cap)) {
    throw new IpcPayloadTooLargeError(measureIpcPayloadBytes(msg), cap);
  }
  return cap;
}

/**
 * Post one IPC message when under the payload cap (fire-and-forget).
 * Prefer {@link sendWorkerIpcMessageAndDrain} for the worker's FINAL result/error
 * so the process does not exit before the parent observes the message.
 *
 * @throws {IpcPayloadTooLargeError} When the serialized message exceeds `maxBytes`.
 */
export function sendWorkerIpcMessage(msg: unknown, maxBytes?: number): void {
  assertUnderCap(msg, maxBytes);
  process.send?.(msg);
}

/**
 * Post one IPC message and wait until Node reports it written to the channel.
 *
 * `process.send` is asynchronous: if a worker exits immediately after a bare
 * `process.send(result)`, the parent can observe `exit` before `message` —
 * especially on Linux under load — and reject with "exited before producing a
 * result" even though the child completed cleanly. Awaiting the send callback
 * closes that race for terminal result/error messages.
 *
 * @throws {IpcPayloadTooLargeError} When the serialized message exceeds `maxBytes`.
 * @throws {Error} When `process.send` reports a channel error.
 */
export async function sendWorkerIpcMessageAndDrain(msg: unknown, maxBytes?: number): Promise<void> {
  assertUnderCap(msg, maxBytes);
  const send = process.send;
  if (send === undefined) return;
  await new Promise<void>((resolve, reject) => {
    // process.send callback: err is set when the channel is closed/broken.
    // Bind `this` — process.send reads `this.connected` in Node's implementation.
    const ok = send.call(process, msg, (error: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
    // Some Node versions return false when the channel is full / disconnected.
    if (ok === false) {
      reject(new Error('worker IPC channel closed before message could be sent'));
    }
  });
}
