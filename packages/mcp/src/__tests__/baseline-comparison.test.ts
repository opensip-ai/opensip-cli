import { createSignal, type Signal } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { compareSignalsToBaseline } from '../baseline-comparison.js';

import type { BaselineRow } from '@opensip-cli/datastore';

function signal(id: string, fingerprint?: string): Signal {
  const created = createSignal({
    source: 'fit',
    ruleId: `rule-${id}`,
    severity: 'medium',
    message: `finding ${id}`,
    code: { file: `src/${id}.ts`, line: 1, column: 1 },
  });
  return fingerprint === undefined ? created : { ...created, fingerprint };
}

describe('compareSignalsToBaseline', () => {
  it('projects added, unchanged, resolved, missing-fingerprint, and legacy-payload rows', () => {
    const current = [signal('added', 'fp-added'), signal('same', 'fp-same'), signal('missing')];
    const baselineRows: BaselineRow[] = [
      { fingerprint: 'fp-same', payload: signal('same', 'fp-same') },
      { fingerprint: 'fp-resolved', payload: signal('resolved', 'fp-resolved') },
      { fingerprint: 'fp-legacy', payload: null },
    ];

    const result = compareSignalsToBaseline({
      current,
      baselineRows,
      includeResolved: true,
      limit: 1,
    });

    expect(result.delta).toEqual({
      added: 1,
      resolved: 2,
      unchanged: 1,
      missingFingerprint: 1,
    });
    expect(result.addedFindings.map((finding) => finding.ruleId)).toEqual(['rule-added']);
    expect(result.resolvedFindings?.map((finding) => finding.filePath)).toEqual([
      'src/resolved.ts',
    ]);
    expect(result.degraded).toEqual([
      {
        code: 'missing-fingerprint',
        message: '1 current signal(s) lacked a baseline fingerprint.',
        count: 1,
      },
      {
        code: 'legacy-baseline-payload',
        message:
          '1 resolved baseline row(s) had no stored payload, so resolved finding details are incomplete.',
        count: 1,
      },
    ]);
  });

  /**
   * Regression: when NO current signal carries a fingerprint (exactly what a
   * replayed session used to produce, because the persisted payload dropped the
   * stamp), `currentFingerprints` is empty and every baseline row trivially
   * looks resolved. `compare_to_baseline` then answered "all 12 findings were
   * fixed" for a run whose findings were unchanged, with the
   * `missing-fingerprint` note doing nothing to stop the wrong number being
   * emitted as if confident.
   */
  it('refuses to report a confident resolved count when NO current signal is fingerprinted', () => {
    const baselineRows: BaselineRow[] = [
      { fingerprint: 'fp-1', payload: signal('one', 'fp-1') },
      { fingerprint: 'fp-2', payload: signal('two', 'fp-2') },
    ];

    const result = compareSignalsToBaseline({
      current: [signal('a'), signal('b')],
      baselineRows,
      includeResolved: true,
    });

    expect(result.delta).toEqual({
      added: 0,
      resolved: 0,
      unchanged: 0,
      missingFingerprint: 2,
    });
    expect(result.resolvedFindings).toEqual([]);
    expect(result.degraded?.map((d) => d.code)).toEqual(['comparison-unavailable']);
    expect(result.degraded?.[0]?.count).toBe(2);
  });

  it('still reports resolved rows when only SOME current signals lack a fingerprint', () => {
    const result = compareSignalsToBaseline({
      current: [signal('same', 'fp-same'), signal('missing')],
      baselineRows: [
        { fingerprint: 'fp-same', payload: signal('same', 'fp-same') },
        { fingerprint: 'fp-gone', payload: signal('gone', 'fp-gone') },
      ],
    });

    expect(result.delta).toMatchObject({ resolved: 1, unchanged: 1, missingFingerprint: 1 });
    expect(result.degraded?.map((d) => d.code)).toEqual(['missing-fingerprint']);
  });

  it('a genuinely clean run (no current signals) still reports its baseline rows as resolved', () => {
    const result = compareSignalsToBaseline({
      current: [],
      baselineRows: [{ fingerprint: 'fp-1', payload: signal('one', 'fp-1') }],
    });

    expect(result.delta).toMatchObject({ resolved: 1, missingFingerprint: 0 });
    expect(result.degraded).toBeUndefined();
  });

  it('omits optional resolved and degraded sections when not requested or unnecessary', () => {
    const result = compareSignalsToBaseline({
      current: [signal('same', 'fp-same')],
      baselineRows: [{ fingerprint: 'fp-same', payload: signal('same', 'fp-same') }],
    });

    expect(result.delta).toMatchObject({ added: 0, resolved: 0, unchanged: 1 });
    expect(result.resolvedFindings).toBeUndefined();
    expect(result.degraded).toBeUndefined();
  });
});
