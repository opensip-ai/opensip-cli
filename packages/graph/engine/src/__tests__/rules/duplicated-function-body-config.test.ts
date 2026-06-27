/**
 * Configuration paths for the duplicated-function-body rule.
 *
 * Validates the `minDuplicateBodyLines` and `minDuplicateBodySize`
 * thresholds, plus the kind/test-file exclusions.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { duplicatedFunctionBodyRule } from '../../rules/duplicated-function-body.js';

import { makeCatalog, occ } from './_helpers.js';

import type { FunctionOccurrence } from '../../types.js';

const span10: Partial<FunctionOccurrence> = {
  line: 1,
  endLine: 10,
  bodySize: 500,
};

describe('duplicated-function-body config thresholds', () => {
  it('skips occurrences whose source span is below minDuplicateBodyLines', () => {
    const a = occ({
      bodyHash: 'h',
      simpleName: 'a',
      line: 1,
      endLine: 3,
      bodySize: 500,
    });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      filePath: 'src/b.ts',
      line: 1,
      endLine: 3,
      bodySize: 500,
    });
    const catalog = makeCatalog([a, b]);
    const signals = duplicatedFunctionBodyRule.evaluate(catalog, buildIndexes(catalog), {
      minDuplicateBodyLines: 5,
      minDuplicateBodySize: 0,
    });
    expect(signals).toHaveLength(0);
  });

  it('flags duplicates when minDuplicateBodyLines is satisfied', () => {
    const a = occ({ bodyHash: 'h', simpleName: 'a', ...span10 });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      filePath: 'src/b.ts',
      ...span10,
    });
    const catalog = makeCatalog([a, b]);
    const signals = duplicatedFunctionBodyRule.evaluate(catalog, buildIndexes(catalog), {
      minDuplicateBodyLines: 5,
      minDuplicateBodySize: 0,
    });
    expect(signals.length).toBeGreaterThanOrEqual(1);
  });

  it('skips occurrences whose normalized body size is below minDuplicateBodySize', () => {
    const a = occ({
      bodyHash: 'h',
      simpleName: 'a',
      line: 1,
      endLine: 10,
      bodySize: 50,
    });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      filePath: 'src/b.ts',
      line: 1,
      endLine: 10,
      bodySize: 50,
    });
    const catalog = makeCatalog([a, b]);
    const signals = duplicatedFunctionBodyRule.evaluate(catalog, buildIndexes(catalog), {
      minDuplicateBodyLines: 0,
      minDuplicateBodySize: 200,
    });
    expect(signals).toHaveLength(0);
  });

  it('treats missing bodySize as passing the size threshold (legacy catalog)', () => {
    const a = occ({
      bodyHash: 'h',
      simpleName: 'a',
      line: 1,
      endLine: 10,
      bodySize: undefined,
    });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      filePath: 'src/b.ts',
      line: 1,
      endLine: 10,
      bodySize: undefined,
    });
    const catalog = makeCatalog([a, b]);
    const signals = duplicatedFunctionBodyRule.evaluate(catalog, buildIndexes(catalog), {
      minDuplicateBodyLines: 0,
      minDuplicateBodySize: 999_999,
    });
    expect(signals.length).toBeGreaterThanOrEqual(1);
  });

  it('skips arrow / function-expression / module-init occurrences', () => {
    const a = occ({ bodyHash: 'h', simpleName: 'a', kind: 'arrow', ...span10 });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      kind: 'arrow',
      filePath: 'src/b.ts',
      ...span10,
    });
    const catalog = makeCatalog([a, b]);
    const signals = duplicatedFunctionBodyRule.evaluate(catalog, buildIndexes(catalog), {
      minDuplicateBodyLines: 0,
      minDuplicateBodySize: 0,
    });
    expect(signals).toHaveLength(0);
  });

  it('skips occurrences inside test files', () => {
    const a = occ({
      bodyHash: 'h',
      simpleName: 'a',
      filePath: 'src/__tests__/a.test.ts',
      inTestFile: true,
      ...span10,
    });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      filePath: 'src/__tests__/b.test.ts',
      inTestFile: true,
      ...span10,
    });
    const catalog = makeCatalog([a, b]);
    const signals = duplicatedFunctionBodyRule.evaluate(catalog, buildIndexes(catalog), {
      minDuplicateBodyLines: 0,
      minDuplicateBodySize: 0,
    });
    expect(signals).toHaveLength(0);
  });

  it('uses default thresholds when config does not override', () => {
    // span = 10 lines (passes default minLines=5), bodySize = 500 (passes default minBodySize=200)
    const a = occ({ bodyHash: 'h', simpleName: 'aa', ...span10 });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'bb',
      filePath: 'src/b.ts',
      ...span10,
    });
    const catalog = makeCatalog([a, b]);
    const signals = duplicatedFunctionBodyRule.evaluate(catalog, buildIndexes(catalog), {});
    expect(signals.length).toBeGreaterThanOrEqual(1);
    const s0 = signals[0];
    expect(s0?.metadata.groupSize).toBe(2);
    expect(s0?.suggestion).toContain('Extract');
  });

  it('produces N-1 signals for a group of N duplicates', () => {
    const a = occ({ bodyHash: 'h', simpleName: 'a', ...span10 });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      filePath: 'src/b.ts',
      ...span10,
    });
    const c = occ({
      bodyHash: 'h',
      simpleName: 'c',
      filePath: 'src/c.ts',
      ...span10,
    });
    const catalog = makeCatalog([a, b, c]);
    const signals = duplicatedFunctionBodyRule.evaluate(catalog, buildIndexes(catalog), {});
    expect(signals).toHaveLength(2);
  });
});
