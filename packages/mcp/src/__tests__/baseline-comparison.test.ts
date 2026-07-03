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
