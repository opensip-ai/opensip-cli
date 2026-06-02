/**
 * Rule parity for feature-column reads (Plan C, Phase 5/7.4).
 *
 * Each refactored rule must (a) produce an IDENTICAL signal set whether the
 * engine FeatureTable is supplied or omitted (graceful-degrade fallback), and
 * (b) actually READ the column when supplied — a column value that would flip
 * the verdict changes the output, proving the column (not the inline fallback)
 * drove the decision.
 */

import { describe, expect, it } from 'vitest';

import { buildFeatures } from '../../pipeline/features.js';
import { buildIndexes } from '../../pipeline/indexes.js';
import { duplicatedFunctionBodyRule } from '../../rules/duplicated-function-body.js';
import { noSideEffectPathRule } from '../../rules/no-side-effect-path.js';
import { orphanSubtreeRule } from '../../rules/orphan-subtree.js';
import { testOnlyReachableRule } from '../../rules/test-only-reachable.js';

import { makeCatalog, occ, staticCall } from './_helpers.js';

import type { FeatureTable, FunctionFeatures, GraphConfig, Rule } from '../../types.js';

const CONFIG: GraphConfig = {};

/** Build the FeatureTable a rule declares via featureDeps. */
function featuresFor(rule: Rule, catalog: ReturnType<typeof makeCatalog>): FeatureTable {
  const indexes = buildIndexes(catalog);
  return buildFeatures(catalog, indexes, CONFIG, rule.featureDeps ?? []);
}

function messages(signals: readonly { message: string }[]): string[] {
  return signals.map((s) => s.message).sort();
}

describe('rule feature-column parity — features present vs absent', () => {
  it('duplicated-function-body: identical signals with and without features', () => {
    // Two identical big bodies across packages → a dup signal.
    const a = occ({ bodyHash: 'dup', simpleName: 'fmt', filePath: 'packages/a/src/x.ts', qualifiedName: 'a.fmt', endLine: 30, bodySize: 400 });
    const b = occ({ bodyHash: 'dup', simpleName: 'fmt', filePath: 'packages/b/src/x.ts', qualifiedName: 'b.fmt', endLine: 30, bodySize: 400 });
    const catalog = makeCatalog([a, b]);
    const indexes = buildIndexes(catalog);
    const features = featuresFor(duplicatedFunctionBodyRule, catalog);
    const withF = duplicatedFunctionBodyRule.evaluate(catalog, indexes, CONFIG, undefined, features);
    const without = duplicatedFunctionBodyRule.evaluate(catalog, indexes, CONFIG);
    expect(messages(withF)).toEqual(messages(without));
    expect(without.length).toBeGreaterThan(0);
    expect(duplicatedFunctionBodyRule.featureDeps).toEqual(['bodyLines']);
  });

  it('no-side-effect-path: identical signals with and without features', () => {
    // A pure ≥10-line function that calls two other pure functions.
    const pure = occ({ bodyHash: 'p', simpleName: 'compute', endLine: 14, returnType: 'number',
      calls: [staticCall('h1'), staticCall('h2')] });
    const h1 = occ({ bodyHash: 'h1', simpleName: 'h1', returnType: 'number' });
    const h2 = occ({ bodyHash: 'h2', simpleName: 'h2', returnType: 'number' });
    const catalog = makeCatalog([pure, h1, h2]);
    const indexes = buildIndexes(catalog);
    const features = featuresFor(noSideEffectPathRule, catalog);
    const withF = noSideEffectPathRule.evaluate(catalog, indexes, CONFIG, undefined, features);
    const without = noSideEffectPathRule.evaluate(catalog, indexes, CONFIG);
    expect(messages(withF)).toEqual(messages(without));
    expect(noSideEffectPathRule.featureDeps).toEqual(['bodyLines']);
  });

  it('orphan-subtree: identical signals with and without features', () => {
    const orphan = occ({ bodyHash: 'o', simpleName: 'lonely', visibility: 'module-local' });
    const entry = occ({ bodyHash: 'e', simpleName: 'main', visibility: 'exported', calls: [staticCall('used')] });
    const used = occ({ bodyHash: 'used', simpleName: 'used', visibility: 'module-local' });
    const catalog = makeCatalog([orphan, entry, used]);
    const indexes = buildIndexes(catalog);
    const features = featuresFor(orphanSubtreeRule, catalog);
    const withF = orphanSubtreeRule.evaluate(catalog, indexes, CONFIG, undefined, features);
    const without = orphanSubtreeRule.evaluate(catalog, indexes, CONFIG);
    expect(messages(withF)).toEqual(messages(without));
    expect(without.some((s) => s.message.includes('lonely'))).toBe(true);
    expect(orphanSubtreeRule.featureDeps).toEqual(['reachableFromEntry']);
  });

  it('test-only-reachable: identical signals with and without features', () => {
    const helper = occ({ bodyHash: 'h', simpleName: 'helper', visibility: 'module-local' });
    const testCaller = occ({ bodyHash: 't', simpleName: 'spec', filePath: 'src/__tests__/x.test.ts',
      inTestFile: true, calls: [staticCall('h')] });
    const catalog = makeCatalog([helper, testCaller]);
    const indexes = buildIndexes(catalog);
    const features = featuresFor(testOnlyReachableRule, catalog);
    const withF = testOnlyReachableRule.evaluate(catalog, indexes, CONFIG, undefined, features);
    const without = testOnlyReachableRule.evaluate(catalog, indexes, CONFIG);
    expect(messages(withF)).toEqual(messages(without));
    expect(without.some((s) => s.message.includes('helper'))).toBe(true);
    expect(testOnlyReachableRule.featureDeps).toEqual(['reachableOnlyFromTests']);
  });
});

describe('rule feature-column parity — the column actually drives the verdict', () => {
  it('duplicated-function-body honors a bodyLines column below the min-lines floor', () => {
    // Real span is 30 lines (above the default 5-line floor) → without a
    // features override, this is a dup. Feed a features table whose bodyLines
    // for the hash is BELOW the floor; the rule must drop it, proving it read
    // the column rather than the inline endLine−line+1 fallback.
    const a = occ({ bodyHash: 'dup', simpleName: 'fmt', filePath: 'packages/a/src/x.ts', qualifiedName: 'a.fmt', endLine: 30, bodySize: 400 });
    const b = occ({ bodyHash: 'dup', simpleName: 'fmt', filePath: 'packages/b/src/x.ts', qualifiedName: 'b.fmt', endLine: 30, bodySize: 400 });
    const catalog = makeCatalog([a, b]);
    const indexes = buildIndexes(catalog);
    const config: GraphConfig = { minDuplicateBodyLines: 10, minCrossPackageDuplicatePackages: 99 };

    // Sanity: without the override this is flagged (per-instance path).
    const flagged = duplicatedFunctionBodyRule.evaluate(catalog, indexes, config);
    expect(flagged.length).toBeGreaterThan(0);

    // Override bodyLines below the 10-line floor → dropped.
    const fnRow: FunctionFeatures = { bodyLines: 3 };
    const features: FeatureTable = {
      function: new Map([['dup', fnRow]]),
      package: new Map(),
      scc: [],
      edge: [],
    };
    const dropped = duplicatedFunctionBodyRule.evaluate(catalog, indexes, config, undefined, features);
    expect(dropped.length).toBe(0);
  });

  it('orphan-subtree honors a reachableFromEntry column that marks the orphan reachable', () => {
    const orphan = occ({ bodyHash: 'o', simpleName: 'lonely', visibility: 'module-local' });
    const catalog = makeCatalog([orphan]);
    const indexes = buildIndexes(catalog);

    // Without features: 'lonely' is an orphan.
    const flagged = orphanSubtreeRule.evaluate(catalog, indexes, CONFIG);
    expect(flagged.some((s) => s.message.includes('lonely'))).toBe(true);

    // Feed a features table that declares 'o' reachable → not flagged.
    const fnRow: FunctionFeatures = { bodyLines: 5, reachableFromEntry: true };
    const features: FeatureTable = {
      function: new Map([['o', fnRow]]),
      package: new Map(),
      scc: [],
      edge: [],
    };
    const cleared = orphanSubtreeRule.evaluate(catalog, indexes, CONFIG, undefined, features);
    expect(cleared.some((s) => s.message.includes('lonely'))).toBe(false);
  });
});
