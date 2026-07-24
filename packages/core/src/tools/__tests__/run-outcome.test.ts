import { describe, expect, it } from 'vitest';

import { deriveRunOutcome, inferStoredRunOutcome } from '../run-outcome.js';

describe('deriveRunOutcome', () => {
  it('honors an explicit tool outcome (e.g. strict degraded)', () => {
    expect(deriveRunOutcome({ passed: true, explicit: 'degraded' })).toBe('degraded');
    expect(deriveRunOutcome({ passed: false, explicit: 'error' })).toBe('error');
  });

  it('maps the scan verdict to passed/failed when no explicit outcome is set', () => {
    expect(deriveRunOutcome({ passed: true })).toBe('passed');
    expect(deriveRunOutcome({ passed: false })).toBe('failed');
  });

  it('inferStoredRunOutcome preserves stored value and legacy passed only', () => {
    expect(inferStoredRunOutcome({ passed: true, runOutcome: 'degraded' })).toBe('degraded');
    expect(inferStoredRunOutcome({ passed: true })).toBe('passed');
    expect(inferStoredRunOutcome({ passed: false })).toBe('failed');
  });
});
