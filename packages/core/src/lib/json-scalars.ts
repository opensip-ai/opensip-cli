/** JSON-safe scalar metadata value persisted in session-detail payloads. */
export type JsonScalar = string | number | boolean;

/**
 * True when `value` is a finite number (not `NaN` / `±Infinity`).
 * Shared admission guard for write-plane and decode/project surfaces (ADR-0180).
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Narrow an open metadata bag to the JSON-safe scalar subset accepted by
 * persisted session-detail payloads. Nested objects and non-finite numbers
 * are intentionally dropped (ADR-0180).
 */
export function projectJsonScalarMetadata(
  metadata: Record<string, unknown> | undefined,
): Readonly<Record<string, JsonScalar>> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, JsonScalar> = {};
  let any = false;
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' || typeof value === 'boolean' || isFiniteNumber(value)) {
      out[key] = value;
      any = true;
    }
  }
  return any ? out : undefined;
}
