/**
 * graph:large-function band-boundary tests.
 *
 * Bands: `bodyLines <= 80` → nothing; `(80, 150]` → medium; `> 150` → high.
 * `bodyLines` is read from the feature column when present, else the inline
 * `endLine − line + 1` span. These tests drive the inline span (no features),
 * plus one features-driven case and one config override.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { largeFunctionRule } from '../../rules/large-function.js';

import { makeCatalog, occ } from './_helpers.js';

import type { FeatureTable, GraphConfig } from '../../types.js';

const EMPTY: GraphConfig = {};

/** Single occurrence whose span (endLine − line + 1) is `lines`. */
function withLines(lines: number) {
  const o = occ({ bodyHash: 'h', simpleName: 'fn', line: 1, endLine: lines });
  return buildIndexes(makeCatalog([o]));
}

function run(lines: number, config: GraphConfig = EMPTY) {
  return largeFunctionRule.evaluate(makeCatalog([]), withLines(lines), config);
}

describe('graph:large-function bands', () => {
  it('emits nothing at the warn boundary (80 lines)', () => {
    expect(run(80)).toEqual([]);
  });

  it('emits medium just over the warn boundary (81 lines)', () => {
    const signals = run(81);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('medium');
    expect(signals[0]?.metadata.bodyLines).toBe(81);
  });

  it('emits medium at the error boundary (150 lines)', () => {
    const signals = run(150);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('medium');
  });

  it('emits high just over the error boundary (151 lines)', () => {
    const signals = run(151);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('high');
  });

  it('reads the bodyLines feature column when present', () => {
    const o = occ({ bodyHash: 'h', simpleName: 'fn', line: 1, endLine: 10 });
    const indexes = buildIndexes(makeCatalog([o]));
    // Inline span is 10 (nothing), but the column says 200 → high.
    const features: FeatureTable = {
      function: new Map([['h', { bodyLines: 200 }]]),
      package: new Map(),
      scc: [],
      edge: [],
    };
    const signals = largeFunctionRule.evaluate(makeCatalog([]), indexes, EMPTY, undefined, features);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('high');
    expect(signals[0]?.metadata.bodyLines).toBe(200);
  });

  it('honors a lowered warn threshold via config', () => {
    // 60 lines: silent at default 80, but medium when warn lowered to 50.
    expect(run(60)).toEqual([]);
    const signals = run(60, { largeFunctionWarnLines: 50 });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('medium');
  });

  it('returns [] for an empty catalog', () => {
    expect(largeFunctionRule.evaluate(makeCatalog([]), buildIndexes(makeCatalog([])), EMPTY)).toEqual([]);
  });
});
