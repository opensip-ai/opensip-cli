/**
 * Tests for the test-only-reachable rule.
 *
 * The rule flags non-test functions whose only callers live in test files.
 * Module-init, exported, generated, orphan, and prod-reachable occurrences
 * are exempted.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { testOnlyReachableRule } from '../../rules/test-only-reachable.js';

import { makeCatalog, occ, staticCall } from './_helpers.js';

describe('test-only-reachable rule', () => {
  it('flags a non-exported helper called only from a test file', () => {
    const helper = occ({ bodyHash: 'h', simpleName: 'helper', visibility: 'module-local' });
    const testCaller = occ({
      bodyHash: 't',
      simpleName: 'spec',
      filePath: 'src/__tests__/foo.test.ts',
      inTestFile: true,
      calls: [staticCall('h')],
    });
    const catalog = makeCatalog([helper, testCaller]);
    const indexes = buildIndexes(catalog);
    const signals = testOnlyReachableRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('helper'))).toBe(true);
  });

  it('does not flag exported helpers (might be intentional test-callable API)', () => {
    const helper = occ({ bodyHash: 'h', simpleName: 'helper', visibility: 'exported' });
    const testCaller = occ({
      bodyHash: 't',
      simpleName: 'spec',
      filePath: 'src/__tests__/foo.test.ts',
      inTestFile: true,
      calls: [staticCall('h')],
    });
    const catalog = makeCatalog([helper, testCaller]);
    const indexes = buildIndexes(catalog);
    const signals = testOnlyReachableRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('helper'))).toBe(false);
  });

  it('does not flag a function that is also called from a prod entry point', () => {
    const helper = occ({ bodyHash: 'h', simpleName: 'helper', visibility: 'module-local' });
    const main = occ({
      bodyHash: 'm',
      simpleName: 'main',
      visibility: 'exported',
      calls: [staticCall('h')],
    });
    const testCaller = occ({
      bodyHash: 't',
      simpleName: 'spec',
      filePath: 'src/__tests__/foo.test.ts',
      inTestFile: true,
      calls: [staticCall('h')],
    });
    const catalog = makeCatalog([helper, main, testCaller]);
    const indexes = buildIndexes(catalog);
    const signals = testOnlyReachableRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('helper'))).toBe(false);
  });

  it('does not flag orphans (callers list empty)', () => {
    const orphan = occ({ bodyHash: 'h', simpleName: 'orphan', visibility: 'module-local' });
    const catalog = makeCatalog([orphan]);
    const indexes = buildIndexes(catalog);
    const signals = testOnlyReachableRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('orphan'))).toBe(false);
  });

  it('does not flag occurrences inside test files themselves', () => {
    const testHelper = occ({
      bodyHash: 'h',
      simpleName: 'testHelper',
      filePath: 'src/__tests__/foo.test.ts',
      inTestFile: true,
    });
    const spec = occ({
      bodyHash: 's',
      simpleName: 'spec',
      filePath: 'src/__tests__/foo.test.ts',
      inTestFile: true,
      calls: [staticCall('h')],
    });
    const catalog = makeCatalog([testHelper, spec]);
    const indexes = buildIndexes(catalog);
    const signals = testOnlyReachableRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('testHelper'))).toBe(false);
  });

  it('does not flag generated occurrences', () => {
    const helper = occ({
      bodyHash: 'h',
      simpleName: 'helper',
      visibility: 'module-local',
      definedInGenerated: true,
    });
    const testCaller = occ({
      bodyHash: 't',
      simpleName: 'spec',
      filePath: 'src/__tests__/foo.test.ts',
      inTestFile: true,
      calls: [staticCall('h')],
    });
    const catalog = makeCatalog([helper, testCaller]);
    const indexes = buildIndexes(catalog);
    const signals = testOnlyReachableRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('helper'))).toBe(false);
  });

  it('does not flag module-init occurrences', () => {
    const moduleInit = occ({
      bodyHash: 'mi',
      simpleName: '<module-init:a.ts>',
      kind: 'module-init',
    });
    const catalog = makeCatalog([moduleInit]);
    const indexes = buildIndexes(catalog);
    const signals = testOnlyReachableRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('module-init'))).toBe(false);
  });

  it('flags a chain of test-only helpers (helper-of-test-helper)', () => {
    const inner = occ({ bodyHash: 'i', simpleName: 'innerHelper', visibility: 'module-local' });
    const outer = occ({
      bodyHash: 'o',
      simpleName: 'outerHelper',
      visibility: 'module-local',
      calls: [staticCall('i')],
    });
    const spec = occ({
      bodyHash: 's',
      simpleName: 'spec',
      filePath: 'src/__tests__/foo.test.ts',
      inTestFile: true,
      calls: [staticCall('o')],
    });
    const catalog = makeCatalog([inner, outer, spec]);
    const indexes = buildIndexes(catalog);
    const signals = testOnlyReachableRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('outerHelper'))).toBe(true);
    // inner has only outer as caller; outer is a non-test caller, so
    // the `every caller in test file` predicate does NOT fire for inner.
    // We deliberately don't assert inner here — the implementation
    // intentionally treats it as ambiguous.
  });
});
