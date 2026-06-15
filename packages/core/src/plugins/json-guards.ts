/**
 * @fileoverview Universal JSON-value type guards shared by the manifest loader
 * and the capability-discovery normalizer. Kept tiny and dependency-free — these
 * are the shallow shape checks that gate untrusted manifest JSON before it is
 * read as a typed structure.
 */

/** Type guard: a value is a plain `Record<string, unknown>` (object, non-null, non-array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Type guard: a value is a `readonly string[]`. */
export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((a) => typeof a === 'string');
}
