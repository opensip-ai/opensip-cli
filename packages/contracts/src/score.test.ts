import { describe, expect, it } from 'vitest';

import { passRate } from './score.js';

describe('passRate', () => {
  it('is the rounded passed/total percentage', () => {
    expect(passRate({ total: 4, passed: 4 })).toBe(100);
    expect(passRate({ total: 4, passed: 1 })).toBe(25);
    expect(passRate({ total: 2, passed: 1 })).toBe(50);
  });

  it('rounds to the nearest integer', () => {
    expect(passRate({ total: 3, passed: 1 })).toBe(33);
    expect(passRate({ total: 3, passed: 2 })).toBe(67);
  });

  it('is 100 for an empty run (no checks) — matches the gate-baseline convention', () => {
    expect(passRate({ total: 0, passed: 0 })).toBe(100);
  });

  it('does not penalize warnings: all-passed scores 100 regardless of finding volume', () => {
    // The graph regression: every check passed (warnings only), so the
    // pass rate is 100 even though the run had many findings.
    expect(passRate({ total: 1, passed: 1 })).toBe(100);
  });
});
