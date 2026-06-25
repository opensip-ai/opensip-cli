/**
 * IPC payload measurement — defense-in-depth byte cap for structured-clone IPC
 * (DD1). Uses V8 serialization to approximate the on-wire size.
 */

import { serialize } from 'node:v8';

/** Measure serialized byte length of an IPC payload. */
export function measureIpcPayloadBytes(payload: unknown): number {
  return serialize(payload).byteLength;
}

/** True when the payload exceeds the configured ceiling. */
export function isIpcPayloadTooLarge(payload: unknown, maxBytes: number): boolean {
  return measureIpcPayloadBytes(payload) > maxBytes;
}
