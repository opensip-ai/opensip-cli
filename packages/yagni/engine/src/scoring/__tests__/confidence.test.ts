import { describe, expect, it } from 'vitest';

import { createYagniSignal } from '../../detectors/create-yagni-signal.js';
import {
  buildYagniRunSummary,
  filterByMinConfidence,
  filterByReductionCategories,
  readYagniMetadata,
  severityForConfidence,
  sortYagniSignals,
} from '../confidence.js';

import type { Signal } from '@opensip-cli/core';

interface MkOpts {
  id?: string;
  confidence?: 'low' | 'medium' | 'high';
  net?: number;
  kind?: 'exact' | 'lower-bound' | 'heuristic';
  detector?: string;
  category?: string;
  file?: string;
  line?: number;
  column?: number;
  withLocDelta?: boolean;
}

function mk(opts: MkOpts = {}): Signal {
  const {
    id = 'd',
    confidence = 'medium',
    net = 0,
    kind = 'exact',
    detector = id,
    category = 'config',
    file = `/r/${id}.ts`,
    line = 1,
    column = 1,
    withLocDelta = true,
  } = opts;
  return createYagniSignal({
    source: `yagni:${id}`,
    ruleId: `yagni:${id}`,
    severity: severityForConfidence(confidence),
    category: 'quality',
    message: id,
    suggestion: `fix ${id}`,
    code: { file, line, column },
    yagni: {
      detector,
      reductionCategory: category as never,
      confidence,
      ...(withLocDelta
        ? { locDelta: { remove: net, add: 0, netEstimate: net, estimateKind: kind } }
        : {}),
      preservationArgument: 'x',
      suggestedAction: 'x',
      validationRequired: [],
      riskTags: [],
      evidence: [],
    },
  });
}

/** A signal carrying no yagni metadata — `readYagniMetadata` returns undefined. */
function noMeta(file: string, line?: number, column?: number): Signal {
  return { ...mk({ file }), line, column, metadata: {} };
}

const detectors = (signals: readonly Signal[]): string[] =>
  signals.map((s) => readYagniMetadata(s)?.detector ?? '∅');

describe('readYagniMetadata', () => {
  it('returns undefined when metadata.yagni is absent or non-object', () => {
    expect(readYagniMetadata(noMeta('/a.ts'))).toBeUndefined();
    expect(readYagniMetadata({ ...mk(), metadata: { yagni: null } })).toBeUndefined();
  });
});

describe('sortYagniSignals tie-breaker chain', () => {
  it('orders by confidence DESC first', () => {
    const out = sortYagniSignals([
      mk({ id: 'lo', confidence: 'low' }),
      mk({ id: 'hi', confidence: 'high' }),
      mk({ id: 'me', confidence: 'medium' }),
    ]);
    expect(detectors(out)).toEqual(['hi', 'me', 'lo']);
  });

  it('breaks a confidence tie by estimateKind DESC', () => {
    const out = sortYagniSignals([
      mk({ id: 'heur', kind: 'heuristic' }),
      mk({ id: 'exact', kind: 'exact' }),
    ]);
    expect(detectors(out)).toEqual(['exact', 'heur']);
  });

  it('breaks a confidence+kind tie by netEstimate DESC', () => {
    const out = sortYagniSignals([mk({ id: 'small', net: 5 }), mk({ id: 'big', net: 20 })]);
    expect(detectors(out)).toEqual(['big', 'small']);
  });

  it('breaks a confidence+kind+net tie by detector name ASC', () => {
    const out = sortYagniSignals([
      mk({ id: 'z', detector: 'zeta', net: 7 }),
      mk({ id: 'a', detector: 'alpha', net: 7 }),
    ]);
    expect(detectors(out)).toEqual(['alpha', 'zeta']);
  });

  it('breaks a full tie by location, tolerating absent line/column', () => {
    // Two no-metadata signals tie on every keyed field, falling through to
    // locationKey — which must coalesce undefined line/column to 0.
    // noMeta() leaves line/column undefined, exercising locationKey's `?? 0`.
    const out = sortYagniSignals([noMeta('/b.ts'), noMeta('/a.ts')]);
    expect(out[0].filePath).toBe('/a.ts');
  });
});

describe('filterByMinConfidence', () => {
  it('keeps at/above floor, drops below, and passes through no-metadata signals', () => {
    const kept = filterByMinConfidence(
      [mk({ id: 'lo', confidence: 'low' }), mk({ id: 'hi', confidence: 'high' }), noMeta('/n.ts')],
      'medium',
    );
    expect(detectors(kept).sort()).toEqual(['hi', '∅']);
  });
});

describe('filterByReductionCategories', () => {
  it('returns all when no categories are given', () => {
    const all = [mk({ id: 'a' }), mk({ id: 'b' })];
    expect(filterByReductionCategories(all, [])).toHaveLength(2);
  });

  it('filters by category and passes through no-metadata signals', () => {
    const out = filterByReductionCategories(
      [
        mk({ id: 'cfg', category: 'config' }),
        mk({ id: 'dead', category: 'dead-code' }),
        noMeta('/n.ts'),
      ],
      ['config'],
    );
    expect(detectors(out).sort()).toEqual(['cfg', '∅']);
  });
});

describe('buildYagniRunSummary', () => {
  it('tallies confidence buckets + LOC, skips no-metadata, and maps skipped detectors', () => {
    const summary = buildYagniRunSummary(
      [
        mk({ id: 'h', confidence: 'high', net: 10 }),
        mk({ id: 'm', confidence: 'medium', net: 5 }),
        mk({ id: 'l', confidence: 'low', withLocDelta: false }),
        noMeta('/n.ts'),
      ],
      'build',
      [
        { id: 'wd', slug: 'with-detail', reason: 'graph-unavailable', detail: 'go' },
        { id: 'nd', slug: 'no-detail', reason: 'disabled' },
      ],
    );
    expect(summary.byConfidence).toEqual({ high: 1, medium: 1, low: 1 });
    expect(summary.estimatedTotalLocReduction).toBe(15);
    expect(summary.totalCandidates).toBe(4);
    expect(summary.graphMode).toBe('build');
    expect(summary.skippedDetectors).toEqual([
      { slug: 'with-detail', reason: 'graph-unavailable', detail: 'go' },
      { slug: 'no-detail', reason: 'disabled' },
    ]);
  });
});

describe('severityForConfidence', () => {
  it('maps high → medium and everything else → low', () => {
    expect(severityForConfidence('high')).toBe('medium');
    expect(severityForConfidence('medium')).toBe('low');
    expect(severityForConfidence('low')).toBe('low');
  });
});
