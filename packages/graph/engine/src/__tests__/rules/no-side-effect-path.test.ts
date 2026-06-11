/**
 * Tests for the no-side-effect-path rule.
 *
 * Conditions to flag a function: not module-init, not in test file,
 * exported, span >= 10 lines, >= 2 calls, no unresolved edges, no
 * textual side-effects in any callee (transitively), and at least one
 * caller invokes it as an ExpressionStatement (discarded=true).
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { noSideEffectPathRule } from '../../rules/no-side-effect-path.js';

import { edge, makeCatalog, occ } from './_helpers.js';

import type { CallEdge, FunctionOccurrence } from '../../types.js';

const exportedDefaults: Partial<FunctionOccurrence> = { visibility: 'exported', endLine: 20 };

function ed(text: string, to: readonly string[], discarded?: boolean): CallEdge {
  return { ...edge(text, to, discarded), resolution: 'static', confidence: 'high' };
}

describe('no-side-effect-path rule', () => {
  it('flags an exported pure function whose caller discards its return value', () => {
    const helperA = occ({ bodyHash: 'ha', simpleName: 'helperA', ...exportedDefaults });
    const helperB = occ({ bodyHash: 'hb', simpleName: 'helperB', ...exportedDefaults });
    const pure = occ({
      bodyHash: 'p',
      simpleName: 'pureCalc',
      ...exportedDefaults,
      calls: [ed('helperA()', ['ha']), ed('helperB()', ['hb'])],
    });
    const caller = occ({
      bodyHash: 'c',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [ed('pureCalc()', ['p'], true)],
    });
    const catalog = makeCatalog([pure, helperA, helperB, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('pureCalc'))).toBe(true);
  });

  it('does not flag when caller consumes the return value (discarded=false)', () => {
    const helperA = occ({ bodyHash: 'ha', simpleName: 'helperA', ...exportedDefaults });
    const helperB = occ({ bodyHash: 'hb', simpleName: 'helperB', ...exportedDefaults });
    const pure = occ({
      bodyHash: 'p',
      simpleName: 'pureCalc',
      ...exportedDefaults,
      calls: [ed('helperA()', ['ha']), ed('helperB()', ['hb'])],
    });
    const caller = occ({
      bodyHash: 'c',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [ed('const x = pureCalc()', ['p'], false)],
    });
    const catalog = makeCatalog([pure, helperA, helperB, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('pureCalc'))).toBe(false);
  });

  it('does not flag when a callee is side-effecting (console)', () => {
    const helper = occ({
      bodyHash: 'h',
      simpleName: 'helper',
      ...exportedDefaults,
      calls: [ed('console.log("x")', [])],
    });
    const pure = occ({
      bodyHash: 'p',
      simpleName: 'maybePure',
      ...exportedDefaults,
      calls: [ed('helper()', ['h']), ed('helper()', ['h'])],
    });
    const caller = occ({
      bodyHash: 'c',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [ed('maybePure()', ['p'], true)],
    });
    const catalog = makeCatalog([pure, helper, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('maybePure'))).toBe(false);
  });

  it('does not flag a non-exported function (ineligible candidate)', () => {
    const helperA = occ({ bodyHash: 'ha', simpleName: 'helperA', ...exportedDefaults });
    const helperB = occ({ bodyHash: 'hb', simpleName: 'helperB', ...exportedDefaults });
    const pure = occ({
      bodyHash: 'p',
      simpleName: 'localPure',
      visibility: 'module-local',
      endLine: 20,
      calls: [ed('helperA()', ['ha']), ed('helperB()', ['hb'])],
    });
    const caller = occ({
      bodyHash: 'c',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [ed('localPure()', ['p'], true)],
    });
    const catalog = makeCatalog([pure, helperA, helperB, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('localPure'))).toBe(false);
  });

  it('does not flag when source span is < 10 lines', () => {
    const helperA = occ({ bodyHash: 'ha', simpleName: 'helperA', ...exportedDefaults });
    const helperB = occ({ bodyHash: 'hb', simpleName: 'helperB', ...exportedDefaults });
    const pure = occ({
      bodyHash: 'p',
      simpleName: 'tinyPure',
      visibility: 'exported',
      line: 1,
      endLine: 5,
      calls: [ed('helperA()', ['ha']), ed('helperB()', ['hb'])],
    });
    const caller = occ({
      bodyHash: 'c',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [ed('tinyPure()', ['p'], true)],
    });
    const catalog = makeCatalog([pure, helperA, helperB, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('tinyPure'))).toBe(false);
  });

  it('does not flag when there are unresolved edges', () => {
    const helperA = occ({ bodyHash: 'ha', simpleName: 'helperA', ...exportedDefaults });
    const pure = occ({
      bodyHash: 'p',
      simpleName: 'partial',
      ...exportedDefaults,
      calls: [ed('helperA()', ['ha']), ed('whoKnows()', [])],
    });
    const caller = occ({
      bodyHash: 'c',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [ed('partial()', ['p'], true)],
    });
    const catalog = makeCatalog([pure, helperA, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('partial'))).toBe(false);
  });

  it('falls back to legacy behavior on catalogs without `discarded` field', () => {
    const helperA = occ({ bodyHash: 'ha', simpleName: 'helperA', ...exportedDefaults });
    const helperB = occ({ bodyHash: 'hb', simpleName: 'helperB', ...exportedDefaults });
    const pure = occ({
      bodyHash: 'p',
      simpleName: 'oldCatalog',
      ...exportedDefaults,
      calls: [ed('helperA()', ['ha']), ed('helperB()', ['hb'])],
    });
    // edge with no `discarded` field at all
    const caller = occ({
      bodyHash: 'c',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [
        {
          to: ['p'],
          line: 1,
          column: 0,
          resolution: 'static',
          confidence: 'high',
          text: 'oldCatalog()',
        },
      ],
    });
    const catalog = makeCatalog([pure, helperA, helperB, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('oldCatalog'))).toBe(true);
  });

  it('does not flag a module-init occurrence even when otherwise eligible', () => {
    const helperA = occ({ bodyHash: 'ha', simpleName: 'helperA', ...exportedDefaults });
    const helperB = occ({ bodyHash: 'hb', simpleName: 'helperB', ...exportedDefaults });
    const init = occ({
      bodyHash: 'mi',
      simpleName: '<module-init:a.ts>',
      kind: 'module-init',
      ...exportedDefaults,
      calls: [ed('helperA()', ['ha']), ed('helperB()', ['hb'])],
    });
    const catalog = makeCatalog([init, helperA, helperB]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('module-init'))).toBe(false);
  });

  it('does not flag occurrences in test files', () => {
    const helperA = occ({ bodyHash: 'ha', simpleName: 'helperA', ...exportedDefaults });
    const helperB = occ({ bodyHash: 'hb', simpleName: 'helperB', ...exportedDefaults });
    const inTest = occ({
      bodyHash: 'p',
      simpleName: 'inTestPure',
      filePath: 'src/__tests__/x.test.ts',
      inTestFile: true,
      ...exportedDefaults,
      calls: [ed('helperA()', ['ha']), ed('helperB()', ['hb'])],
    });
    const caller = occ({
      bodyHash: 'c',
      simpleName: 'caller',
      filePath: 'src/__tests__/x.test.ts',
      inTestFile: true,
      ...exportedDefaults,
      calls: [ed('inTestPure()', ['p'], true)],
    });
    const catalog = makeCatalog([inTest, helperA, helperB, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('inTestPure'))).toBe(false);
  });

  it('does not flag when there is no caller at all', () => {
    const helperA = occ({ bodyHash: 'ha', simpleName: 'helperA', ...exportedDefaults });
    const helperB = occ({ bodyHash: 'hb', simpleName: 'helperB', ...exportedDefaults });
    const pure = occ({
      bodyHash: 'p',
      simpleName: 'unused',
      ...exportedDefaults,
      calls: [ed('helperA()', ['ha']), ed('helperB()', ['hb'])],
    });
    const catalog = makeCatalog([pure, helperA, helperB]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('unused'))).toBe(false);
  });

  // Regression guard for the false positives: an effect-only function
  // declared `: void` (or `Promise<void>`) has no return value to discard,
  // so the "discarded return value" premise is vacuous. Its real effect
  // (closure rebind / throw-delegation / out-param mutation) is invisible
  // to the textual purity heuristic, which is exactly why it looked "pure".
  it.each(['void', 'Promise<void>'])(
    'does not flag a void-like (%s) effect-only function whose caller discards the call',
    (returnType) => {
      const helperA = occ({ bodyHash: 'ha', simpleName: 'helperA', ...exportedDefaults });
      const helperB = occ({ bodyHash: 'hb', simpleName: 'helperB', ...exportedDefaults });
      const effectOnly = occ({
        bodyHash: 'p',
        simpleName: 'rebuildLookups',
        ...exportedDefaults,
        returnType,
        calls: [ed('helperA()', ['ha']), ed('helperB()', ['hb'])],
      });
      const caller = occ({
        bodyHash: 'c',
        simpleName: 'caller',
        ...exportedDefaults,
        calls: [ed('rebuildLookups()', ['p'], true)],
      });
      const catalog = makeCatalog([effectOnly, helperA, helperB, caller]);
      const indexes = buildIndexes(catalog);
      const signals = noSideEffectPathRule.evaluate(catalog, indexes, {});
      expect(signals.some((s) => s.message.includes('rebuildLookups'))).toBe(false);
    },
  );

  // True positive preserved: a value-returning pure function whose result
  // is thrown away is still dead computation and must still flag.
  it('still flags a value-returning (number) pure function whose caller discards its return', () => {
    const helperA = occ({ bodyHash: 'ha', simpleName: 'helperA', ...exportedDefaults });
    const helperB = occ({ bodyHash: 'hb', simpleName: 'helperB', ...exportedDefaults });
    const pure = occ({
      bodyHash: 'p',
      simpleName: 'computeTotal',
      ...exportedDefaults,
      returnType: 'number',
      calls: [ed('helperA()', ['ha']), ed('helperB()', ['hb'])],
    });
    const caller = occ({
      bodyHash: 'c',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [ed('computeTotal()', ['p'], true)],
    });
    const catalog = makeCatalog([pure, helperA, helperB, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('computeTotal'))).toBe(true);
  });

  // Unknown return type (null = unannotated/inferred) must NOT be
  // over-rejected: a genuinely-pure un-annotated function whose result is
  // dropped is still a real finding. Rejecting null would be a false negative.
  it('still flags a pure function with a null (unknown) return type whose caller discards it', () => {
    const helperA = occ({ bodyHash: 'ha', simpleName: 'helperA', ...exportedDefaults });
    const helperB = occ({ bodyHash: 'hb', simpleName: 'helperB', ...exportedDefaults });
    const pure = occ({
      bodyHash: 'p',
      simpleName: 'inferredPure',
      ...exportedDefaults,
      returnType: null,
      calls: [ed('helperA()', ['ha']), ed('helperB()', ['hb'])],
    });
    const caller = occ({
      bodyHash: 'c',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [ed('inferredPure()', ['p'], true)],
    });
    const catalog = makeCatalog([pure, helperA, helperB, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('inferredPure'))).toBe(true);
  });
});
