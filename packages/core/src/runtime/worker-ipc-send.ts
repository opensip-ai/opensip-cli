/**
 * Worker-side IPC send guard — reject oversize payloads before `process.send` (DD1).
 */

import { isIpcPayloadTooLarge, measureIpcPayloadBytes } from './ipc-payload.js';
import { getWorkerLimits } from './worker-limits.js';

export class IpcPayloadTooLargeError extends Error {
  readonly failureClass = 'payload_too_large' as const;
  constructor(bytes: number, maxBytes: number) {
    super(`worker IPC payload too large (${String(bytes)} > ${String(maxBytes)} bytes)`);
    this.name = 'IpcPayloadTooLargeError';
  }
}

/** Post one IPC message when under the payload cap; otherwise throw. */
export function sendWorkerIpcMessage(msg: unknown, maxBytes?: number): void {
  const cap = maxBytes ?? getWorkerLimits().maxIpcBytes;
  if (isIpcPayloadTooLarge(msg, cap)) {
    throw new IpcPayloadTooLargeError(measureIpcPayloadBytes(msg), cap);
  }
  process.send?.(msg);
}
