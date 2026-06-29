/** JSON-safe scalar metadata value persisted in session-detail payloads. */
export type JsonScalar = string | number | boolean;

/**
 * Narrow an open metadata bag to the JSON-safe scalar subset accepted by
 * persisted session-detail payloads. Nested objects are intentionally dropped.
 */
export function projectJsonScalarMetadata(
  metadata: Record<string, unknown> | undefined,
): Readonly<Record<string, JsonScalar>> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, JsonScalar> = {};
  let any = false;
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      any = true;
    }
  }
  return any ? out : undefined;
}
