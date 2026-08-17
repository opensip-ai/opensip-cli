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
      // `out[key] = value` on a plain `{}` invokes Object.prototype's
      // `__proto__` setter when key === '__proto__', silently dropping the
      // metadata field instead of storing it. defineProperty always creates
      // a normal own data property.
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      any = true;
    }
  }
  return any ? out : undefined;
}
