/**
 * ID generation for opensip-tools.
 * Uses ULID for time-sortable, unique identifiers.
 */

import { randomUUID } from 'node:crypto';

import { ulid } from 'ulid';

/** Generate a ULID (time-sortable, 26 lowercase crockford base32 chars) */
export function generateId(prefix?: string): string {
  const id = ulid();
  return prefix ? `${prefix}_${id}` : id;
}

/** Generate a prefixed ULID — e.g., generatePrefixedId('run') → 'RUN_01HXYZ...' */
export function generatePrefixedId(prefix: string): string {
  return `${prefix.toUpperCase()}_${ulid()}`;
}

/** Extract the timestamp from a ULID string. Returns null if invalid. */
export function extractTimestamp(id: string): Date | null {
  // ULIDs are exactly 26 Crockford Base32 chars; the prefix (if any) may
  // contain underscores itself — e.g. `generatePrefixedId('my_tool')`
  // produces `MY_TOOL_<ulid>`. Splitting on the first '_' would slice off
  // only `MY` and leave `TOOL_<ulid>`, failing the length check. Take the
  // trailing 26 chars instead, since ULIDs never contain underscores.
  const ulidPart = id.length >= 26 ? id.slice(-26) : id;
  if (ulidPart.length !== 26) return null;

  try {
    // ULID encodes timestamp in first 10 chars as Crockford Base32
    const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const upper = ulidPart.toUpperCase();
    let time = 0;
    for (let i = 0; i < 10; i++) {
      const idx = ENCODING.indexOf(upper[i]);
      if (idx === -1) return null;
      time = time * 32 + idx;
    }
    return new Date(time);
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- parse-or-null helper; exception → null is the function's contract, caller checks for null.
    return null;
  }
}

/** Generate a standard UUID v4 (for cases where ULID is not appropriate) */
export function generateUUID(): string {
  return randomUUID();
}
