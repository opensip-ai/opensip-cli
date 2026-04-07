/**
 * ID generation for opensip-tools.
 * Uses ULID for time-sortable, unique identifiers.
 */

import { ulid } from 'ulid';
import { randomUUID } from 'node:crypto';

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
  // Strip prefix if present (e.g., 'RUN_01HXYZ...' → '01HXYZ...')
  const underscoreIdx = id.indexOf('_');
  const ulidPart = underscoreIdx >= 0 ? id.slice(underscoreIdx + 1) : id;
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
    return null;
  }
}

/** Generate a standard UUID v4 (for cases where ULID is not appropriate) */
export function generateUUID(): string {
  return randomUUID();
}
