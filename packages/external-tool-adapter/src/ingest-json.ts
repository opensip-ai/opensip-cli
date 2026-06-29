/**
 * @fileoverview Small reusable, defensive JSON navigation helpers (ADR-0091).
 *
 * The per-scanner JSON `parse` lives in each adapter (each scanner's JSON shape
 * differs); these are the shared, total accessors a parser uses to walk a
 * foreign, possibly-malformed document without throwing. All pure.
 */

/** The result of a defensive JSON parse — never throws. */
export type JsonParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

/** Parse JSON, returning a Result instead of throwing on malformed input. */
export function safeParseJson(raw: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Narrow to a plain object (not an array, not null), else `undefined`. */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Narrow to an array, else `undefined`. */
export function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

/** Read a string property, else `undefined`. */
export function getString(obj: unknown, key: string): string | undefined {
  const record = asObject(obj);
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read a finite-number property (coercing a numeric string), else `undefined`. */
export function getNumber(obj: unknown, key: string): number | undefined {
  const record = asObject(obj);
  const value = record?.[key];
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Walk a dotted-ish path of object keys (`navigate(doc, ['results', '0', 'id'])`),
 * descending objects and arrays (numeric segments index arrays). Returns
 * `undefined` on the first missing/typed-wrong step — never throws.
 */
export function navigate(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else {
      const record = asObject(current);
      current = record?.[segment];
    }
  }
  return current;
}
