/**
 * graph:high-blast-untested predicate & severity-ladder tests.
 *
 * Predicate: `blast.score >= warn && !testReachable`. The banding LOGIC
 * (`>= error` → high; `[warn, error)` → medium; `< warn` → nothing) is tested
 * against EXPLICIT thresholds so it stays valid when the defaults are tuned; a
 * separate case locks the shipped defaults (warn 75 / error 150). ABSOLUTE
 * thresholds, never percentile (ADR-0001). A test-reachable or low-blast
 * function emits nothing; the rule emits nothing when the feature table is
 * absent (no in-rule recompute).
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { highBlastUntestedRule } from '../../rules/high-blast-untested.js';

import { makeCatalog, occ } from './_helpers.js';

import type { BlastScore, FeatureTable, FunctionFeatures, GraphConfig } from '../../types.js';

const EMPTY: GraphConfig = {};
/** Explicit thresholds so the banding logic is tested independent of the defaults. */
const BANDS: GraphConfig = { highBlastWarnThreshold: 8, highBlastErrorThreshold: 20 };

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

function run(row: FunctionFeatures, config: GraphConfig = BANDS) {
  const { catalog, indexes, features } = fixture(row);
  return highBlastUntestedRule.evaluate(catalog, indexes, config, undefined, features);
}

describe('graph:high-blast-untested predicate (explicit thresholds 8/20)', () => {
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

  it('emits nothing at warn minus one (7), medium at warn (8)', () => {
    expect(run({ bodyLines: 5, blast: blast(7), testReachable: false })).toEqual([]);
    expect(run({ bodyLines: 5, blast: blast(8), testReachable: false })[0]?.severity).toBe(
      'medium',
    );
  });

  it('emits medium just under the error boundary (19), high at error (20)', () => {
    expect(run({ bodyLines: 5, blast: blast(19), testReachable: false })[0]?.severity).toBe(
      'medium',
    );
    expect(run({ bodyLines: 5, blast: blast(20), testReachable: false })[0]?.severity).toBe('high');
  });

  it('honors a lowered warn threshold via config', () => {
    // blast 5: silent at warn 8, but medium when warn lowered to 4.
    expect(run({ bodyLines: 5, blast: blast(5), testReachable: false })).toEqual([]);
    const signals = run(
      { bodyLines: 5, blast: blast(5), testReachable: false },
      { highBlastWarnThreshold: 4 },
    );
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
    expect(
      highBlastUntestedRule.evaluate(
        makeCatalog([]),
        buildIndexes(makeCatalog([])),
        EMPTY,
        undefined,
        empty,
      ),
    ).toEqual([]);
  });

  it('emits nothing for a function DEFINED in a test file (test code, not a production defect)', () => {
    // A high-blast, "untested" row that would normally fire — but the occurrence
    // lives in a test file, so it must be skipped (a function in a test file
    // can't meaningfully be "not reached by a test").
    const o = occ({ bodyHash: 'h', simpleName: 'reach', inTestFile: true });
    const catalog = makeCatalog([o]);
    const features: FeatureTable = {
      function: new Map([['h', { bodyLines: 5, blast: blast(25), testReachable: false }]]),
      package: new Map(),
      scc: [],
      edge: [],
    };
    expect(
      highBlastUntestedRule.evaluate(catalog, buildIndexes(catalog), BANDS, undefined, features),
    ).toEqual([]);
  });
});

describe('graph:high-blast-untested shipped defaults (warn 75 / error 150)', () => {
  it('is silent below 75, medium in [75, 150), high at/above 150', () => {
    expect(run({ bodyLines: 5, blast: blast(74), testReachable: false }, EMPTY)).toEqual([]);
    expect(run({ bodyLines: 5, blast: blast(75), testReachable: false }, EMPTY)[0]?.severity).toBe(
      'medium',
    );
    expect(run({ bodyLines: 5, blast: blast(149), testReachable: false }, EMPTY)[0]?.severity).toBe(
      'medium',
    );
    expect(run({ bodyLines: 5, blast: blast(150), testReachable: false }, EMPTY)[0]?.severity).toBe(
      'high',
    );
  });
});
