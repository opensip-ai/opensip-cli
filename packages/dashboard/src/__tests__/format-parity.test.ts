import { describe, it, expect } from 'vitest';

import { formatDuration, formatScore } from '@opensip-cli/format';

/** Must match @opensip-cli/format goldens (ADR-0144 lexical identity). */
const DURATION_GOLDENS: readonly [number, string][] = [
  [0, '0ms'],
  [450, '450ms'],
  [999, '999ms'],
  [1000, '1.0s'],
  [12_340, '12.3s'],
  [19_850, '19.9s'],
  [59_949, '59.9s'],
  [59_950, '1m 0.0s'],
  [1_471_600, '24m 31.6s'],
];

describe('dashboard format parity with @opensip-cli/format', () => {
  it.each(DURATION_GOLDENS)('formatDuration(%s) === %s', (ms, label) => {
    expect(formatDuration(ms)).toBe(label);
  });

  it('formatScore cases', () => {
    expect(formatScore(0)).toBe('0%');
    expect(formatScore(67)).toBe('67%');
    expect(formatScore(100)).toBe('100%');
  });
});
