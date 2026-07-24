import { describe, expect, it } from 'vitest';

import { deriveRunOutcome, inferStoredRunOutcome } from '../run-outcome.js';

describe('deriveRunOutcome (Plan 00 contextual projection)', () => {
  it('honors explicit tool outcome', () => {
    expect(
      deriveRunOutcome({
        passed: true,
        explicit: 'degraded',
        executionFaulted: true,
        hasCredibleEvidence: false,
      }),
    ).toBe('degraded');
  });

  it('setup fault without credible evidence is error', () => {
    expect(
      deriveRunOutcome({
        passed: false,
        phase: 'setup',
        executionFaulted: true,
        hasCredibleEvidence: false,
      }),
    ).toBe('error');
  });

  it('delivery fault does not rewrite credible pass', () => {
    expect(
      deriveRunOutcome({
        passed: true,
        phase: 'delivery',
        executionFaulted: true,
        hasCredibleEvidence: true,
      }),
    ).toBe('passed');
  });

  it('execution pass/fail without fault', () => {
    expect(deriveRunOutcome({ passed: true })).toBe('passed');
    expect(deriveRunOutcome({ passed: false })).toBe('failed');
  });

  it.each([
    {
      name: 'execution fault without evidence',
      input: {
        passed: false,
        phase: 'execution' as const,
        executionFaulted: true,
        hasCredibleEvidence: false,
      },
      expected: 'error',
    },
    {
      name: 'persistence fault without evidence',
      input: {
        passed: false,
        phase: 'persistence' as const,
        executionFaulted: true,
        hasCredibleEvidence: false,
      },
      expected: 'error',
    },
    {
      name: 'shutdown fault without evidence',
      input: {
        passed: true,
        phase: 'shutdown' as const,
        executionFaulted: true,
        hasCredibleEvidence: false,
      },
      expected: 'error',
    },
    {
      name: 'delivery fault keeps failed scan verdict',
      input: {
        passed: false,
        phase: 'delivery' as const,
        executionFaulted: true,
        hasCredibleEvidence: true,
      },
      expected: 'failed',
    },
    {
      name: 'credible execution fault still uses passed flag',
      input: {
        passed: true,
        phase: 'execution' as const,
        executionFaulted: true,
        hasCredibleEvidence: true,
      },
      expected: 'passed',
    },
  ])('$name', ({ input, expected }) => {
    expect(deriveRunOutcome(input)).toBe(expected);
  });

  it('inferStoredRunOutcome preserves stored value and legacy passed only', () => {
    expect(inferStoredRunOutcome({ passed: true, runOutcome: 'degraded' })).toBe('degraded');
    expect(inferStoredRunOutcome({ passed: true })).toBe('passed');
    expect(inferStoredRunOutcome({ passed: false })).toBe('failed');
  });
});
