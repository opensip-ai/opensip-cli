import { describe, expect, it } from 'vitest';

import { compareCodePointStrings } from '../code-point-order.js';

describe('compareCodePointStrings', () => {
  it('orders by Unicode code point, not UTF-16 code unit', () => {
    // U+E000 (BMP private use) must sort before U+10000 (astral).
    // UTF-16 unit order would place the astral surrogate pair first.
    expect(compareCodePointStrings('\uE000', '\u{10000}')).toBeLessThan(0);
    expect(compareCodePointStrings('\u{10000}', '\uE000')).toBeGreaterThan(0);
  });

  it('returns zero for equal strings', () => {
    expect(compareCodePointStrings('alpha', 'alpha')).toBe(0);
    expect(compareCodePointStrings('', '')).toBe(0);
  });

  it('orders by shared-prefix then by remaining length', () => {
    expect(compareCodePointStrings('ab', 'abc')).toBeLessThan(0);
    expect(compareCodePointStrings('abc', 'ab')).toBeGreaterThan(0);
    expect(compareCodePointStrings('a', 'b')).toBeLessThan(0);
  });

  it('compares multi-code-point strings at the first differing point', () => {
    expect(compareCodePointStrings('a\u{1F600}c', 'a\u{1F601}c')).toBeLessThan(0);
    expect(compareCodePointStrings('a\u{1F601}c', 'a\u{1F600}c')).toBeGreaterThan(0);
  });
});
