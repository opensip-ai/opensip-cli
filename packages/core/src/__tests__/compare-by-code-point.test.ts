/**
 * `compareByCodePoint` — the kernel's deterministic, locale-independent string
 * comparator. Pins the exact semantics inherited from contracts'
 * `compareCodePoint`: JavaScript's native UTF-16 relational comparison,
 * including its astral-plane behavior (surrogate-pair ordering).
 */

import { describe, expect, it } from 'vitest';

import { compareByCodePoint } from '../index.js';

describe('compareByCodePoint', () => {
  it('orders plain strings deterministically', () => {
    expect(compareByCodePoint('a', 'b')).toBe(-1);
    expect(compareByCodePoint('b', 'a')).toBe(1);
  });

  it('returns 0 for equal strings', () => {
    expect(compareByCodePoint('', '')).toBe(0);
    expect(compareByCodePoint('same', 'same')).toBe(0);
  });

  it('sorts a strict prefix before its extension', () => {
    expect(compareByCodePoint('abc', 'abcd')).toBe(-1);
    expect(compareByCodePoint('abcd', 'abc')).toBe(1);
  });

  it('orders astral-plane characters by their UTF-16 surrogate pairs', () => {
    // U+1F600 encodes as the surrogate pair \uD83D\uDE00; \uD83D < \uFFFD, so the emoji sorts
    // BEFORE U+FFFD despite the larger code point — the contracts semantics
    // this helper must preserve exactly.
    expect(compareByCodePoint('\u{1F600}', '\uFFFD')).toBe(-1);
    expect(compareByCodePoint('\uFFFD', '\u{1F600}')).toBe(1);
    // Two astral characters still order by code point (same high surrogate
    // range keeps surrogate order aligned with code-point order).
    expect(compareByCodePoint('\u{10000}', '\u{10001}')).toBe(-1);
  });
});
