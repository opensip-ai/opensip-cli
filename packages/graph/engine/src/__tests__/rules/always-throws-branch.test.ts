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

  // ── Nested-function / returned-closure false positives ────────────
  //
  // A `throw` inside a nested function expression / arrow that the outer
  // function merely RETURNS or PASSES is not the outer function's own
  // control flow — the throw fires only when the inner callable is later
  // invoked. The canonical real-world case is a Proxy `get` trap:
  //   get(_t, prop) { return () => { throw new Error(...) } }
  // The trap does NOT throw; it returns a lazily-throwing closure.

  it('does not flag a returned arrow whose only edge is a throw (Proxy get-trap closure)', () => {
    // The enclosing `get` trap CREATES the inner arrow (a `[creates] …`
    // edge whose target is the arrow's bodyHash) and returns it. The inner
    // arrow's only edge is the throw — but it is a returned closure, so it
    // must not be flagged.
    const getTrap = occ({
      bodyHash: 'TRAP',
      simpleName: 'get',
      kind: 'method',
      line: 1,
      endLine: 3,
      // Creation edge: the trap creates the inner arrow. Adapters prefix
      // such edges with `[creates] `, and `to` carries the child bodyHash.
      calls: [edge('[creates] () => { throw new Error("unsupported") }', ['ARROW'])],
    });
    const innerArrow = occ({
      bodyHash: 'ARROW',
      simpleName: '<arrow:a.ts:2:11>',
      kind: 'arrow',
      line: 2,
      endLine: 2,
      calls: [edge('throw new Error("unsupported")')],
    });
    const catalog = makeCatalog([getTrap, innerArrow]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {});
    expect(signals).toHaveLength(0);
  });

  it('does not flag an outer function when its only throw edge lives inside a nested function it returns', () => {
    // Some adapters attribute the nested throw edge to the ENCLOSING
    // occurrence. The throw's source line (5) falls inside the nested
    // function's span (4..6), so it is not the outer's own control flow.
    const outer = occ({
      bodyHash: 'OUTER',
      simpleName: 'makeThrower',
      line: 1,
      endLine: 7,
      // The throw edge is positioned inside the nested function's span.
      calls: [{ ...edge('throw new Error("later")'), line: 5 }],
    });
    const nested = occ({
      bodyHash: 'NESTED',
      simpleName: '<fn:a.ts:4:9>',
      kind: 'function-expression',
      line: 4,
      endLine: 6,
      calls: [{ ...edge('throw new Error("later")'), line: 5 }],
    });
    const catalog = makeCatalog([outer, nested]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {});
    // `makeThrower` returns a throwing closure but does not itself throw.
    expect(signals.some((s) => s.message.includes('makeThrower'))).toBe(false);
  });

  it('still flags a function whose OWN body unconditionally throws even when it also declares a nested function', () => {
    // True-positive preservation: the outer function throws in its own
    // control flow (line 2, before the nested declaration at 4..6). The
    // nested-function boundary must not suppress this.
    const outer = occ({
      bodyHash: 'OUTER',
      simpleName: 'guard',
      line: 1,
      endLine: 7,
      calls: [
        { ...edge('throw new Error("precondition")'), line: 2 },
        // An unrelated edge inside a nested closure — dropped from the
        // own-control-flow set, must not change the verdict.
        { ...edge('throw new Error("inner")'), line: 5 },
      ],
    });
    const nested = occ({
      bodyHash: 'NESTED',
      simpleName: '<arrow:a.ts:4:9>',
      kind: 'arrow',
      line: 4,
      endLine: 6,
      calls: [{ ...edge('throw new Error("inner")'), line: 5 }],
    });
    const catalog = makeCatalog([outer, nested]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {});
    const guard = signals.find((s) => s.message.includes('guard'));
    expect(guard).toBeDefined();
    // Only the own-control-flow throw counts toward the edge count.
    expect(guard?.metadata.edgeCount).toBe(1);
  });
});
