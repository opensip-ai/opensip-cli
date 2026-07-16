import { describe, expect, it } from 'vitest';

import {
  codePointSortKey,
  compareCodePointStrings,
  continuationToken,
  matchesContinuationIdentity,
  sortedStringAdjacency,
} from '../code-point-order.js';

describe('code-point-order', () => {
  it('compares equal, prefix, and multi-code-point strings', () => {
    expect(compareCodePointStrings('a', 'a')).toBe(0);
    expect(compareCodePointStrings('a', 'ab')).toBeLessThan(0);
    expect(compareCodePointStrings('ab', 'a')).toBeGreaterThan(0);
    expect(compareCodePointStrings('b', 'a')).toBeGreaterThan(0);
    // Surrogate-pair safe: emoji is one scalar.
    expect(compareCodePointStrings('a😀', 'a😀')).toBe(0);
    expect(compareCodePointStrings('a😀', 'a😁')).not.toBe(0);
  });

  it('builds printable sort keys and opaque continuation tokens', () => {
    expect(codePointSortKey('')).toBe('-');
    expect(codePointSortKey('A')).toMatch(/^[0-9a-f]{6}-$/);
    const token = continuationToken('pkg|a->b');
    expect(token.startsWith('r1:')).toBe(true);
    expect(matchesContinuationIdentity('pkg|a->b', token)).toBe(true);
    expect(matchesContinuationIdentity('other', token)).toBe(false);
  });

  it('sorts adjacency maps by code-point order of keys and neighbors', () => {
    const sorted = sortedStringAdjacency(
      new Map([
        ['b', new Set(['z', 'a'])],
        ['a', new Set(['m', 'c'])],
      ]),
    );
    expect([...sorted.keys()]).toEqual(['a', 'b']);
    expect(sorted.get('a')).toEqual(['c', 'm']);
    expect(sorted.get('b')).toEqual(['a', 'z']);
  });
});
