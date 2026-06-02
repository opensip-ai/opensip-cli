/**
 * Tests for the always-throws-branch rule.
 *
 * The rule fires when every outbound edge of a non-module-init function
 * matches a `throw new <Type>(...)` shape. The textual heuristic operates
 * on `CallEdge.text`, which the inventory pipeline truncates to <=80 chars.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { alwaysThrowsBranchRule } from '../../rules/always-throws-branch.js';

import { edge, makeCatalog, occ } from './_helpers.js';

describe('always-throws-branch rule', () => {
  it('flags a function whose every call is `throw new ...`', () => {
    const a = occ({
      bodyHash: 'a',
      simpleName: 'fail',
      calls: [edge('throw new Error("boom")'), edge('throw new TypeError("nope")')],
    });
    const catalog = makeCatalog([a]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {});
    expect(signals).toHaveLength(1);
    expect(signals[0]?.message).toContain('fail');
    expect(signals[0]?.metadata.edgeCount).toBe(2);
    expect(signals[0]?.suggestion).toContain('Inline the throw');
  });

  it('flags a function whose calls are `throw <CapWord>(...)` (no new keyword)', () => {
    const a = occ({
      bodyHash: 'a',
      simpleName: 'rethrow',
      calls: [edge('throw Error("boom")')],
    });
    const catalog = makeCatalog([a]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {});
    expect(signals).toHaveLength(1);
    expect(signals[0]?.message).toContain('rethrow');
  });

  it('does not flag a function with a non-throw call', () => {
    const a = occ({
      bodyHash: 'a',
      simpleName: 'maybeThrow',
      calls: [edge('throw new Error("x")'), edge('helper()')],
    });
    const catalog = makeCatalog([a]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {});
    expect(signals).toHaveLength(0);
  });

  it('does not flag a function with no calls', () => {
    const a = occ({
      bodyHash: 'a',
      simpleName: 'empty',
      calls: [],
    });
    const catalog = makeCatalog([a]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {});
    expect(signals).toHaveLength(0);
  });

  it('does not flag module-init occurrences even when their only call is a throw', () => {
    const m = occ({
      bodyHash: 'm',
      simpleName: '<module-init:a.ts>',
      kind: 'module-init',
      calls: [edge('throw new Error("top-level")')],
    });
    const catalog = makeCatalog([m]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {});
    expect(signals).toHaveLength(0);
  });

  it('does not flag a test-file occurrence whose every call is a throw', () => {
    // `() => { throw boom }` passed to `expect(...).toThrow(...)` exists to
    // throw by design; flagging it is noise. Test-file occurrences are
    // excluded from this production-code rule.
    const a = occ({
      bodyHash: 'a',
      simpleName: 'toThrowFixture',
      inTestFile: true,
      calls: [edge('throw new Error("boom")'), edge('throw new TypeError("nope")')],
    });
    const catalog = makeCatalog([a]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {});
    expect(signals).toHaveLength(0);
  });

  it('still flags the same always-throw shape when not in a test file', () => {
    const a = occ({
      bodyHash: 'a',
      simpleName: 'toThrowFixture',
      inTestFile: false,
      calls: [edge('throw new Error("boom")'), edge('throw new TypeError("nope")')],
    });
    const catalog = makeCatalog([a]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {});
    expect(signals).toHaveLength(1);
    expect(signals[0]?.message).toContain('toThrowFixture');
  });

  it('does not match non-throw expressions starting with a capitalized identifier', () => {
    const a = occ({
      bodyHash: 'a',
      simpleName: 'callsClass',
      calls: [edge('Foo.bar()')],
    });
    const catalog = makeCatalog([a]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {});
    expect(signals).toHaveLength(0);
  });
});
