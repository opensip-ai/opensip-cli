/**
 * Unit tests for the pure `analyzeGraphSignalStamped` detector (release 2.13.0, §5.9).
 */
import { describe, expect, it } from 'vitest';

import { analyzeGraphSignalStamped } from '../graph-signal-stamped.js';

describe('analyzeGraphSignalStamped', () => {
  it('flags the low-level createSignal call', () => {
    const v = analyzeGraphSignalStamped('signals.push(createSignal({ message }))');
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0]?.message).toContain('createGraphSignal');
  });

  it("flags a hand-typed source: 'graph'", () => {
    expect(analyzeGraphSignalStamped("  source: 'graph',").length).toBeGreaterThanOrEqual(1);
  });

  it('flags a hand-typed ruleId', () => {
    expect(analyzeGraphSignalStamped("  ruleId: 'graph:cycle',").length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag a createGraphSignal call (the blessed factory)', () => {
    expect(
      analyzeGraphSignalStamped("createGraphSignal('graph:cycle', config, { severity, message })"),
    ).toHaveLength(0);
  });
});
