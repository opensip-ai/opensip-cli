/** Deterministic Unicode code-point ordering and printable cursor-key encoding. */

import { createHash } from 'node:crypto';

/** Unicode code-point comparison (not JavaScript's UTF-16 code-unit ordering). */
export function compareCodePointStrings(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const l = left.next();
    const r = right.next();
    if (l.done === true || r.done === true) {
      if (l.done === r.done) return 0;
      return l.done === true ? -1 : 1;
    }
    const lcp = l.value.codePointAt(0) ?? 0;
    const rcp = r.value.codePointAt(0) ?? 0;
    if (lcp !== rcp) return lcp - rcp;
  }
}

/**
 * Printable ASCII key preserving Unicode code-point order. Six hex digits
 * encode each scalar; `-` terminates the field so prefixes sort first.
 */
export function codePointSortKey(value: string): string {
  let out = '';
  for (const character of value) {
    out += (character.codePointAt(0) ?? 0).toString(16).padStart(6, '0');
  }
  return `${out}-`;
}

/** Compact opaque continuation identity for an otherwise potentially large sort key. */
export function continuationToken(stableKey: string): string {
  return `r1:${createHash('sha256').update(stableKey, 'utf8').digest('hex')}`;
}

/** Match a stable sort key to its non-secret opaque pagination identity. */
export function matchesContinuationIdentity(
  stableKey: string,
  continuationIdentity: string,
): boolean {
  return continuationToken(stableKey) === continuationIdentity;
}

/** Freeze string adjacency into deterministic key and neighbor order. */
export function sortedStringAdjacency(
  input: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, readonly string[]> {
  return new Map(
    [...input.entries()]
      .sort(([left], [right]) => compareCodePointStrings(left, right))
      .map(([key, values]) => [key, [...values].sort(compareCodePointStrings)]),
  );
}
