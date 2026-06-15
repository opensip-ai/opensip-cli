import { describe, it, expect } from 'vitest';

import { buildSignalBatch, createSignal, MAX_SIGNALS_PER_BATCH } from '../index.js';

import type { Signal, SignalSeverity } from '../index.js';

function sig(severity: SignalSeverity, i = 0): Signal {
  return createSignal({ source: 'test', severity, ruleId: `rule-${i}`, message: `m${i}` });
}

describe('buildSignalBatch', () => {
  it('stamps schemaVersion, a run id, counts, and createdAt', () => {
    const batch = buildSignalBatch({
      tool: 'fit',
      recipe: 'example',
      repo: { commit: 'abc123' },
      signals: [sig('high'), sig('high'), sig('low')],
    });
    expect(batch.schemaVersion).toBe(1);
    expect(batch.tool).toBe('fit');
    expect(batch.recipe).toBe('example');
    expect(batch.repo.commit).toBe('abc123');
    expect(batch.runId).toMatch(/^RUN_/);
    expect(batch.counts.total).toBe(3);
    expect(batch.counts.bySeverity).toEqual({ high: 2, low: 1 });
    expect(() => new Date(batch.createdAt).toISOString()).not.toThrow();
    expect(batch.truncated).toBeUndefined();
  });

  it('caps the batch and keeps the highest-severity signals, recording the dropped count', () => {
    const signals = [
      ...Array.from({ length: 3 }, (_, i) => sig('low', i)),
      ...Array.from({ length: 2 }, (_, i) => sig('critical', i)),
    ];
    const batch = buildSignalBatch({ tool: 'fit', repo: {}, signals, maxSignals: 2 });
    expect(batch.signals).toHaveLength(2);
    expect(batch.truncated).toEqual({ dropped: 3 });
    // Highest severity kept: both criticals survive, lows dropped.
    expect(batch.signals.every((s) => s.severity === 'critical')).toBe(true);
  });

  it('exposes a non-trivial default cap', () => {
    expect(MAX_SIGNALS_PER_BATCH).toBeGreaterThan(0);
  });
});
