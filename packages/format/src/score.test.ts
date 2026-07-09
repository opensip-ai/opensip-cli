import { describe, it, expect } from 'vitest';

import { formatScore } from './score.js';

describe('formatScore', () => {
  it('formats integer percentages', () => {
    expect(formatScore(0)).toBe('0%');
    expect(formatScore(67)).toBe('67%');
    expect(formatScore(100)).toBe('100%');
  });

  it('rounds finite non-integers without clamping to 0–100', () => {
    expect(formatScore(88.4)).toBe('88%');
    expect(formatScore(150)).toBe('150%');
  });

  it('falls back to 0% for non-finite and negative inputs', () => {
    expect(formatScore(Number.NaN)).toBe('0%');
    expect(formatScore(Number.POSITIVE_INFINITY)).toBe('0%');
    expect(formatScore(-5)).toBe('0%');
  });
});
