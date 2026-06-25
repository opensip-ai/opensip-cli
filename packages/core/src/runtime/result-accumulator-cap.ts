/**
 * ResultAccumulator output cap — bound serialized FRR seam payloads (D2).
 */

import { measureIpcPayloadBytes } from './ipc-payload.js';

export class CapturedOutputTooLargeError extends Error {
  readonly failureClass = 'payload_too_large' as const;
  constructor(field: string, bytes: number, maxBytes: number) {
    super(
      `tool command worker: ${field} output exceeds cap (${String(bytes)} > ${String(maxBytes)} bytes)`,
    );
    this.name = 'CapturedOutputTooLargeError';
  }
}

/**
 * Assert a value fits the captured-output ceiling before recording it.
 *
 * @throws {CapturedOutputTooLargeError} When `value` exceeds `maxBytes` after serialization.
 */
export function assertCapturedOutputFits(field: string, value: unknown, maxBytes: number): void {
  const bytes = measureIpcPayloadBytes(value);
  if (bytes > maxBytes) {
    throw new CapturedOutputTooLargeError(field, bytes, maxBytes);
  }
}
