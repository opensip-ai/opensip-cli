/** Escape serialized JSON so it cannot terminate an inline HTML script block. */
export function escapeJsonForScriptContext(json: string): string {
  return json.replaceAll('<', String.raw`\u003c`).replaceAll('>', String.raw`\u003e`);
}

/**
 * Serialize a value exactly as it will be embedded in an inline script.
 *
 * @throws {TypeError} When the value cannot be represented as JSON.
 */
export function serializeJsonForScriptContext(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError('Cannot serialize undefined as script-context JSON.');
  }
  return escapeJsonForScriptContext(json);
}

/** Measure the UTF-8 bytes of the final script-safe JSON representation. */
export function scriptContextJsonBytes(value: unknown): number {
  return Buffer.byteLength(serializeJsonForScriptContext(value), 'utf8');
}
