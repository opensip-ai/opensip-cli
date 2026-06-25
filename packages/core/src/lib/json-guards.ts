/**
 * @fileoverview Shared shallow JSON-value guards.
 *
 * These intentionally only prove "plain object, not null, not array" and other
 * small container shapes. Deeper schema validation stays with the caller.
 */

/** Type guard: a value is a plain `Record<string, unknown>` (object, non-null, non-array). */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const isRecord = isPlainRecord;

/** Type guard: a value is a `readonly string[]`. */
export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((a) => typeof a === 'string');
}
