import { describe, expect, it } from 'vitest';

import { deriveOutcome } from '../run-outcome.js';

describe('deriveOutcome', () => {
  it("maps a passing verdict to 'passed'", () => {
    expect(deriveOutcome({ passed: true, faulted: false })).toBe('passed');
  });

  it("maps a non-passing, non-faulted verdict to 'failed' (findings crossed the gate)", () => {
    expect(deriveOutcome({ passed: false, faulted: false })).toBe('failed');
  });

  it("maps a faulted verdict to 'faulted' — a fault dominates a findings result", () => {
    // A faulted verdict always has passed=false; the fault bit must win so a
    // crashed run reads 'faulted' (result unknown), not 'failed'.
    expect(deriveOutcome({ passed: false, faulted: true })).toBe('faulted');
  });

  it('degrades a legacy verdict without `faulted` to the binary passed/failed', () => {
    expect(deriveOutcome({ passed: true })).toBe('passed');
    expect(deriveOutcome({ passed: false })).toBe('failed');
  });
});
