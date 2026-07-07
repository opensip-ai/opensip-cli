import { describe, expect, it } from 'vitest';

import { envelopeToResultSummary, unitOutcome } from '../envelope-result-summary.js';

import type { SignalEnvelope, UnitResult } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

function signal(source: string, filePath: string, line?: number): Signal {
  return {
    id: `sig_${source}_${filePath}_${line ?? 0}`,
    source,
    provider: 'fitness',
    severity: 'high',
    category: 'quality',
    ruleId: source,
    message: `finding in ${source}`,
    filePath,
    ...(line === undefined ? {} : { line }),
    metadata: {},
    fingerprint: `${source}|${filePath}|${line ?? 0}|0`,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function envelope(units: UnitResult[], signals: Signal[]): SignalEnvelope {
  return {
    schemaVersion: 2,
    tool: 'fit',
    runId: 'FIT_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    verdict: {
      score: 0,
      passed: false,
      summary: { total: units.length, passed: 0, failed: 0, errors: 0, warnings: 0 },
    },
    units,
    signals,
    baselineIdentity: { fingerprintStrategyId: 'x', fingerprintStrategyVersion: 1 },
  };
}

describe('unitOutcome', () => {
  it('maps a per-unit error to faulted (a check that threw)', () => {
    expect(unitOutcome({ slug: 'a', passed: false, durationMs: 0, error: 'boom' })).toBe('faulted');
  });
  it('maps a non-passing unit with no error to failed', () => {
    expect(unitOutcome({ slug: 'a', passed: false, durationMs: 0 })).toBe('failed');
  });
  it('maps a passing unit to passed', () => {
    expect(unitOutcome({ slug: 'a', passed: true, durationMs: 0 })).toBe('passed');
  });
});

describe('envelopeToResultSummary', () => {
  it('returns undefined for a clean run (every unit passed) — keeps a compact surface', () => {
    const env = envelope(
      [
        { slug: 'a', passed: true, durationMs: 1 },
        { slug: 'b', passed: true, durationMs: 1 },
      ],
      [],
    );
    expect(envelopeToResultSummary(env)).toBeUndefined();
  });

  it('counts units 3-way and attaches finding locations to failed units', () => {
    const env = envelope(
      [
        { slug: 'no-console', passed: false, durationMs: 1 },
        { slug: 'imports-sorted', passed: true, durationMs: 1 },
        { slug: 'complexity', passed: false, durationMs: 1, error: 'threw RangeError' },
      ],
      [signal('no-console', 'src/api.ts', 42), signal('no-console', 'src/db.ts', 17)],
    );
    const summary = envelopeToResultSummary(env);
    expect(summary?.counts).toEqual({ passed: 1, failed: 1, faulted: 1 });
    expect(summary?.items).toEqual([
      { label: 'no-console', outcome: 'failed', detail: 'src/api.ts:42, src/db.ts:17' },
      { label: 'imports-sorted', outcome: 'passed' },
      { label: 'complexity', outcome: 'faulted', detail: 'threw RangeError' },
    ]);
  });

  it('elides finding locations beyond the inline cap with "(+N more)"', () => {
    const env = envelope(
      [{ slug: 'no-console', passed: false, durationMs: 1 }],
      [
        signal('no-console', 'a.ts', 1),
        signal('no-console', 'b.ts', 2),
        signal('no-console', 'c.ts', 3),
        signal('no-console', 'd.ts', 4),
      ],
    );
    expect(envelopeToResultSummary(env)?.items[0]?.detail).toBe('a.ts:1, b.ts:2 (+2 more)');
  });

  it('dedupes repeated locations and omits the line when a signal has none', () => {
    const env = envelope(
      [{ slug: 'r', passed: false, durationMs: 1 }],
      [signal('r', 'x.ts', 5), signal('r', 'x.ts', 5), signal('r', 'y.ts')],
    );
    expect(envelopeToResultSummary(env)?.items[0]?.detail).toBe('x.ts:5, y.ts');
  });

  it('leaves a failed unit with no findings location-less (no detail)', () => {
    const env = envelope([{ slug: 'gate', passed: false, durationMs: 1 }], []);
    const item = envelopeToResultSummary(env)?.items[0];
    expect(item).toEqual({ label: 'gate', outcome: 'failed' });
  });
});
