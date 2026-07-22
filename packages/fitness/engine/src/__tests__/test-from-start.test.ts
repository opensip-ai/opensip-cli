/**
 * @fileoverview Direct tests for `testFromStart` — the regex-safety primitive
 * shared by the check-utils path matchers. It must give a stable, position-0
 * answer whether or not the caller hands it a stateful (global/sticky) regex,
 * without mutating the caller's `lastIndex`.
 */

import { describe, expect, it } from 'vitest';

import { testFromStart } from '../check-utils/path-matching.js';

describe('testFromStart', () => {
  it('tests a non-global, non-sticky pattern directly', () => {
    expect(testFromStart(/^abc/, 'abcdef')).toBe(true);
    expect(testFromStart(/^abc/, 'xabc')).toBe(false);
  });

  it('resets and restores lastIndex for a global pattern so repeated calls are stable', () => {
    const pattern = /a/g;
    pattern.lastIndex = 3; // a dirtied global regex from a prior caller
    expect(testFromStart(pattern, 'a')).toBe(true);
    expect(pattern.lastIndex).toBe(3); // caller's lastIndex is restored untouched
    // A global regex whose lastIndex was NOT reset would fail this second call.
    expect(testFromStart(pattern, 'a')).toBe(true);
  });

  it('resets and restores lastIndex for a sticky pattern too', () => {
    const pattern = /a/y;
    pattern.lastIndex = 5;
    expect(testFromStart(pattern, 'a')).toBe(true);
    expect(pattern.lastIndex).toBe(5);
  });
});
