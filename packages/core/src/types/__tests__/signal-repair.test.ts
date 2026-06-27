import { describe, expect, it } from 'vitest';

import { createSignal } from '../signal.js';

describe('Signal.repair', () => {
  it('round-trips through createSignal and JSON', () => {
    const signal = createSignal({
      source: 'graph',
      ruleId: 'graph:large-function',
      severity: 'high',
      message: 'big',
      repair: {
        repairKind: 'split-function',
        autofixable: false,
        confidence: 0.7,
      },
    });
    expect(signal.repair?.repairKind).toBe('split-function');
    const parsed = structuredClone(signal);
    expect(parsed.repair?.repairKind).toBe('split-function');
  });

  it('omits repair when absent (forward-compat)', () => {
    const signal = createSignal({
      source: 'fit',
      ruleId: 'x',
      severity: 'low',
      message: 'ok',
    });
    expect(signal.repair).toBeUndefined();
    const parsed = structuredClone(signal);
    expect(parsed.repair).toBeUndefined();
  });
});
