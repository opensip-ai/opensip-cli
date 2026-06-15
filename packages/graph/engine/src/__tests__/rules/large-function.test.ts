/**
 * graph:large-function band-boundary tests.
 *
 * The banding LOGIC (`bodyLines <= warn` → nothing; `(warn, error]` → medium;
 * `> error` → high) is exercised against EXPLICIT config thresholds so these
 * tests stay valid when the shipped defaults are tuned; a separate case locks
 * the current defaults (warn 300 / error 500). `bodyLines` is read from the
 * feature column when present, else the inline `endLine − line + 1` span.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { largeFunctionRule } from '../../rules/large-function.js';

import { makeCatalog, occ } from './_helpers.js';

import type { FeatureTable, GraphConfig } from '../../types.js';

const EMPTY: GraphConfig = {};
/** Explicit thresholds so the banding logic is tested independent of the defaults. */
const BANDS: GraphConfig = { largeFunctionWarnLines: 80, largeFunctionErrorLines: 150 };

/** Single occurrence whose span (endLine − line + 1) is `lines`. */
function withLines(lines: number) {
  const o = occ({ bodyHash: 'h', simpleName: 'fn', line: 1, endLine: lines });
  return buildIndexes(makeCatalog([o]));
}

function run(lines: number, config: GraphConfig = BANDS) {
  return largeFunctionRule.evaluate(makeCatalog([]), withLines(lines), config);
}

describe('graph:large-function bands (explicit thresholds 80/150)', () => {
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
    // Inline span is 10 (nothing), but the column says 200 → high (error 150).
    const features: FeatureTable = {
      function: new Map([['h', { bodyLines: 200 }]]),
      package: new Map(),
      scc: [],
      edge: [],
    };
    const signals = largeFunctionRule.evaluate(
      makeCatalog([]),
      indexes,
      BANDS,
      undefined,
      features,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('high');
    expect(signals[0]?.metadata.bodyLines).toBe(200);
  });

  it('honors a lowered warn threshold via config', () => {
    // 60 lines: silent at warn 80, but medium when warn lowered to 50.
    expect(run(60)).toEqual([]);
    const signals = run(60, { largeFunctionWarnLines: 50 });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('medium');
  });

  it('returns [] for an empty catalog', () => {
    expect(
      largeFunctionRule.evaluate(makeCatalog([]), buildIndexes(makeCatalog([])), EMPTY),
    ).toEqual([]);
  });
});

describe('graph:large-function shipped defaults (warn 300 / error 500)', () => {
  it('is silent up to 300, medium in (300, 500], high above 500', () => {
    expect(run(300, EMPTY)).toEqual([]);
    expect(run(301, EMPTY)[0]?.severity).toBe('medium');
    expect(run(500, EMPTY)[0]?.severity).toBe('medium');
    expect(run(501, EMPTY)[0]?.severity).toBe('high');
  });
});

describe('graph:large-function skips non-functions and test files', () => {
  it('does not flag a long <module-init> (whole-file body, not a function)', () => {
    const idx = buildIndexes(
      makeCatalog([
        occ({
          bodyHash: 'm',
          simpleName: '<module-init:src/a.ts>',
          line: 1,
          endLine: 400,
          kind: 'module-init',
        }),
      ]),
    );
    expect(largeFunctionRule.evaluate(makeCatalog([]), idx, BANDS)).toEqual([]);
  });

  it('does not flag a long function defined in a test file', () => {
    const idx = buildIndexes(
      makeCatalog([
        occ({
          bodyHash: 't',
          simpleName: 'bigTestHelper',
          line: 1,
          endLine: 400,
          inTestFile: true,
        }),
      ]),
    );
    expect(largeFunctionRule.evaluate(makeCatalog([]), idx, BANDS)).toEqual([]);
  });
});
