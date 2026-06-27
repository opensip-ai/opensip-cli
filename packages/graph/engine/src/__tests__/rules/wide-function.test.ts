/**
 * graph:wide-function band-boundary tests.
 *
 * The banding LOGIC is exercised against EXPLICIT config thresholds (warn 4 /
 * error 7) so it stays valid when the shipped defaults are tuned; a separate
 * case locks the current defaults (warn 5 / error 7).
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { wideFunctionRule } from '../../rules/wide-function.js';

import { makeCatalog, occ } from './_helpers.js';

import type { GraphConfig, Param } from '../../types.js';

const EMPTY: GraphConfig = {};
/** Explicit thresholds so the banding logic is tested independent of the defaults. */
const BANDS: GraphConfig = {
  wideFunctionWarnParams: 4,
  wideFunctionErrorParams: 7,
};

function params(n: number): Param[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `p${String(i)}`,
    optional: false,
    rest: false,
  }));
}

function run(n: number, config: GraphConfig = BANDS) {
  const o = occ({ bodyHash: 'h', simpleName: 'fn', params: params(n) });
  return wideFunctionRule.evaluate(makeCatalog([]), buildIndexes(makeCatalog([o])), config);
}

describe('graph:wide-function bands (explicit thresholds 4/7)', () => {
  it('emits nothing at the warn boundary (4 params)', () => {
    expect(run(4)).toEqual([]);
  });

  it('emits medium just over the warn boundary (5 params)', () => {
    const signals = run(5);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('medium');
    expect(signals[0]?.metadata.paramCount).toBe(5);
  });

  it('emits medium at the error boundary (7 params)', () => {
    expect(run(7)[0]?.severity).toBe('medium');
  });

  it('emits high just over the error boundary (8 params)', () => {
    expect(run(8)[0]?.severity).toBe('high');
  });

  it('honors a lowered warn threshold via config', () => {
    expect(run(3)).toEqual([]);
    const signals = run(3, { wideFunctionWarnParams: 2 });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('medium');
  });

  it('returns [] for an empty catalog', () => {
    expect(
      wideFunctionRule.evaluate(makeCatalog([]), buildIndexes(makeCatalog([])), EMPTY),
    ).toEqual([]);
  });

  it('does not flag a wide function defined in a test file', () => {
    const o = occ({
      bodyHash: 'h',
      simpleName: 'wideHelper',
      params: params(9),
      inTestFile: true,
    });
    expect(
      wideFunctionRule.evaluate(makeCatalog([]), buildIndexes(makeCatalog([o])), EMPTY),
    ).toEqual([]);
  });
});

describe('graph:wide-function shipped defaults (warn 5 / error 7)', () => {
  it('is silent up to 5, medium in (5, 7], high above 7', () => {
    expect(run(5, EMPTY)).toEqual([]);
    expect(run(6, EMPTY)[0]?.severity).toBe('medium');
    expect(run(7, EMPTY)[0]?.severity).toBe('medium');
    expect(run(8, EMPTY)[0]?.severity).toBe('high');
  });
});
