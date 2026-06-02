/**
 * graph:high-blast-untested predicate & severity-ladder tests.
 *
 * Predicate: `blast.score >= threshold && !testReachable`. Bands (ABSOLUTE,
 * never percentile — ADR-0001): score `>= 20` → high; `[8, 20)` → medium;
 * `< 8` → nothing. A test-reachable function and a low-blast function both
 * emit nothing. Feature columns are synthesized; the rule emits nothing when
 * the feature table is absent (no in-rule recompute).
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { highBlastUntestedRule } from '../../rules/high-blast-untested.js';

import { makeCatalog, occ } from './_helpers.js';

import type { BlastScore, FeatureTable, FunctionFeatures, GraphConfig } from '../../types.js';

const EMPTY: GraphConfig = {};

function blast(score: number): BlastScore {
  return { direct: score, transitive: 0, score };
}

/** One occurrence + a synthesized feature row for it. */
function fixture(row: FunctionFeatures) {
  const o = occ({ bodyHash: 'h', simpleName: 'reach' });
  const catalog = makeCatalog([o]);
  const indexes = buildIndexes(catalog);
  const features: FeatureTable = {
    function: new Map([['h', row]]),
    package: new Map(),
    scc: [],
    edge: [],
  };
  return { catalog, indexes, features };
}

function run(row: FunctionFeatures, config: GraphConfig = EMPTY) {
  const { catalog, indexes, features } = fixture(row);
  return highBlastUntestedRule.evaluate(catalog, indexes, config, undefined, features);
}

describe('graph:high-blast-untested predicate', () => {
  it('emits high for a high-blast untested function', () => {
    const signals = run({ bodyLines: 5, blast: blast(25), testReachable: false });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('high');
    expect(signals[0]?.metadata.testReachable).toBe(false);
    expect(signals[0]?.metadata.blast).toBe(25);
  });

  it('emits medium for a moderate-blast untested function', () => {
    const signals = run({ bodyLines: 5, blast: blast(12), testReachable: false });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('medium');
  });

  it('emits nothing for a high-blast TESTED function', () => {
    expect(run({ bodyLines: 5, blast: blast(25), testReachable: true })).toEqual([]);
  });

  it('emits nothing for a low-blast untested function', () => {
    expect(run({ bodyLines: 5, blast: blast(3), testReachable: false })).toEqual([]);
  });

  it('emits nothing exactly at the warn boundary minus one (7), medium at warn (8)', () => {
    expect(run({ bodyLines: 5, blast: blast(7), testReachable: false })).toEqual([]);
    expect(run({ bodyLines: 5, blast: blast(8), testReachable: false })[0]?.severity).toBe('medium');
  });

  it('emits medium just under the error boundary (19), high at error (20)', () => {
    expect(run({ bodyLines: 5, blast: blast(19), testReachable: false })[0]?.severity).toBe('medium');
    expect(run({ bodyLines: 5, blast: blast(20), testReachable: false })[0]?.severity).toBe('high');
  });

  it('honors a lowered warn threshold via config', () => {
    // blast 5: silent at default warn 8, but medium when warn lowered to 4.
    expect(run({ bodyLines: 5, blast: blast(5), testReachable: false })).toEqual([]);
    const signals = run({ bodyLines: 5, blast: blast(5), testReachable: false }, { highBlastWarnThreshold: 4 });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('medium');
  });

  it('emits nothing when the feature table is absent (no in-rule recompute)', () => {
    const o = occ({ bodyHash: 'h', simpleName: 'reach' });
    const catalog = makeCatalog([o]);
    expect(highBlastUntestedRule.evaluate(catalog, buildIndexes(catalog), EMPTY)).toEqual([]);
  });

  it('emits nothing when the blast column is missing for the row', () => {
    expect(run({ bodyLines: 5, testReachable: false })).toEqual([]);
  });

  it('returns [] for an empty catalog', () => {
    const empty: FeatureTable = { function: new Map(), package: new Map(), scc: [], edge: [] };
    expect(highBlastUntestedRule.evaluate(makeCatalog([]), buildIndexes(makeCatalog([])), EMPTY, undefined, empty)).toEqual([]);
  });
});
