import { describe, expect, it } from 'vitest';

import { enrichDoneWithEnvelope } from '../enrich-done.js';

import type { LiveRunDoneData } from '@opensip-cli/cli-ui';
import type { SignalEnvelope, UnitResult } from '@opensip-cli/contracts';

const DONE: LiveRunDoneData = {
  summary: { passed: false, errors: 1, warnings: 0, durationMs: 5 },
};

function envelope(units: UnitResult[], faulted: boolean): SignalEnvelope {
  return {
    schemaVersion: 2,
    tool: 'fit',
    runId: 'FIT_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    verdict: {
      score: 0,
      passed: false,
      faulted,
      summary: { total: units.length, passed: 0, failed: 0, errors: 1, warnings: 0 },
    },
    units,
    signals: [],
    baselineIdentity: { fingerprintStrategyId: 'x', fingerprintStrategyVersion: 1 },
  };
}

describe('enrichDoneWithEnvelope', () => {
  it('returns the done-data untouched when there is no envelope', () => {
    expect(enrichDoneWithEnvelope(DONE)).toBe(DONE);
  });

  it('folds the envelope fault bit into the summary and derives attention bullets', () => {
    const env = envelope(
      [
        { slug: 'a', passed: true, durationMs: 1 },
        { slug: 'b', passed: false, durationMs: 1 },
        { slug: 'c', passed: false, durationMs: 1, error: 'threw' },
      ],
      true,
    );
    const enriched = enrichDoneWithEnvelope(DONE, env);
    expect(enriched.summary.faulted).toBe(true);
    expect(enriched.attention?.counts).toEqual({ passed: 1, failed: 1, faulted: 1 });
    expect(enriched.attention?.items.map((i) => i.outcome)).toEqual([
      'passed',
      'failed',
      'faulted',
    ]);
  });

  it('sets faulted=false and omits attention for a clean run (nothing to flag)', () => {
    const env = envelope([{ slug: 'a', passed: true, durationMs: 1 }], false);
    const enriched = enrichDoneWithEnvelope(DONE, env);
    expect(enriched.summary.faulted).toBe(false);
    expect(enriched.attention).toBeUndefined();
  });
});
