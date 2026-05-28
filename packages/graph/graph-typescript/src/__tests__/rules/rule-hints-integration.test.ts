/**
 * Rule-hints integration tests — covers the F-1 audit fix.
 *
 * The `no-side-effect-path` and `always-throws-branch` rules consult
 * the active adapter's `ruleHints.sideEffectPrimitives` and
 * `ruleHints.throwSyntaxRegex` so per-language fidelity matches the
 * promise in docs/public/40-graph/02-rules-and-gating.md.
 *
 * What these tests cover:
 *   - Python `print(...)` is detected as a side-effect when the Python
 *     hints are passed; without hints, the TS-shaped fallback would NOT
 *     detect it (regression preview of the audit's headline finding).
 *   - Rust `panic!(...)` matches the `always-throws-branch` regex when
 *     the Rust hints are passed; without hints, the TS-shaped fallback
 *     does NOT match it.
 *   - TypeScript adapter hints continue to work identically to the
 *     previous hardcoded regex (regression check).
 */

import {
  alwaysThrowsBranchRule,
  buildIndexes,
  noSideEffectPathRule,
  type CallEdge,
  type FunctionOccurrence,
} from '@opensip-tools/graph';
import { pythonRuleHints } from '@opensip-tools/graph-python';
import { rustRuleHints } from '@opensip-tools/graph-rust';
import { describe, expect, it } from 'vitest';


import { typescriptGraphAdapter } from '../../index.js';

import { edge, makeCatalog, occ } from './_helpers.js';

const exportedDefaults: Partial<FunctionOccurrence> = {
  visibility: 'exported',
  endLine: 20,
};

function ed(text: string, to: readonly string[], discarded?: boolean): CallEdge {
  return { ...edge(text, to, discarded), resolution: 'static', confidence: 'high' };
}

describe('rule hints — no-side-effect-path', () => {
  it('Python hints: detects print(...) as a side-effect, suppressing the signal', () => {
    // helper transitively reaches print(...) — that is a side-effect
    // with the Python hints, so the candidate is NOT pure-only.
    const sink = occ({
      bodyHash: 'sink',
      simpleName: 'sink',
      ...exportedDefaults,
      calls: [ed('print("hello")', [])],
    });
    const candidate = occ({
      bodyHash: 'cand',
      simpleName: 'maybePure',
      ...exportedDefaults,
      calls: [ed('sink()', ['sink']), ed('sink()', ['sink'])],
    });
    const caller = occ({
      bodyHash: 'caller',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [ed('maybePure()', ['cand'], true)],
    });
    const catalog = makeCatalog([sink, candidate, caller]);
    const indexes = buildIndexes(catalog);

    // With Python hints — print is recognized as side-effecting.
    const withHints = noSideEffectPathRule.evaluate(catalog, indexes, {}, pythonRuleHints);
    expect(withHints.some((s) => s.message.includes('maybePure'))).toBe(false);

    // Without hints — the TS-shaped fallback regex does NOT match
    // `print(...)`, so the rule (incorrectly) flags maybePure as pure.
    // This is the F-1 finding in miniature.
    const withoutHints = noSideEffectPathRule.evaluate(catalog, indexes, {});
    expect(withoutHints.some((s) => s.message.includes('maybePure'))).toBe(true);
  });

  it('Python hints: detects subprocess.run(...) as a side-effect', () => {
    const sink = occ({
      bodyHash: 'sink',
      simpleName: 'runIt',
      ...exportedDefaults,
      calls: [ed('subprocess.run(["ls"])', [])],
    });
    const candidate = occ({
      bodyHash: 'cand',
      simpleName: 'callsRun',
      ...exportedDefaults,
      calls: [ed('runIt()', ['sink']), ed('runIt()', ['sink'])],
    });
    const caller = occ({
      bodyHash: 'caller',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [ed('callsRun()', ['cand'], true)],
    });
    const catalog = makeCatalog([sink, candidate, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {}, pythonRuleHints);
    expect(signals.some((s) => s.message.includes('callsRun'))).toBe(false);
  });

  it('Rust hints: detects println!(...) as a side-effect', () => {
    const sink = occ({
      bodyHash: 'sink',
      simpleName: 'logIt',
      ...exportedDefaults,
      calls: [ed('println!("hi")', [])],
    });
    const candidate = occ({
      bodyHash: 'cand',
      simpleName: 'shoutsHello',
      ...exportedDefaults,
      calls: [ed('logIt()', ['sink']), ed('logIt()', ['sink'])],
    });
    const caller = occ({
      bodyHash: 'caller',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [ed('shoutsHello()', ['cand'], true)],
    });
    const catalog = makeCatalog([sink, candidate, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {}, rustRuleHints);
    expect(signals.some((s) => s.message.includes('shoutsHello'))).toBe(false);
  });

  it('TypeScript hints: console.log still detected (regression check)', () => {
    const sink = occ({
      bodyHash: 'sink',
      simpleName: 'sink',
      ...exportedDefaults,
      calls: [ed('console.log("hi")', [])],
    });
    const candidate = occ({
      bodyHash: 'cand',
      simpleName: 'tsSink',
      ...exportedDefaults,
      calls: [ed('sink()', ['sink']), ed('sink()', ['sink'])],
    });
    const caller = occ({
      bodyHash: 'caller',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [ed('tsSink()', ['cand'], true)],
    });
    const catalog = makeCatalog([sink, candidate, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(
      catalog,
      indexes,
      {},
      typescriptGraphAdapter.ruleHints,
    );
    // console.log is a TS side-effect primitive — so tsSink isn't
    // flagged as pure.
    expect(signals.some((s) => s.message.includes('tsSink'))).toBe(false);
  });

  it('No hints: TS-shaped fallback still detects console.log (regression check)', () => {
    const sink = occ({
      bodyHash: 'sink',
      simpleName: 'sink',
      ...exportedDefaults,
      calls: [ed('console.log("hi")', [])],
    });
    const candidate = occ({
      bodyHash: 'cand',
      simpleName: 'tsSink',
      ...exportedDefaults,
      calls: [ed('sink()', ['sink']), ed('sink()', ['sink'])],
    });
    const caller = occ({
      bodyHash: 'caller',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [ed('tsSink()', ['cand'], true)],
    });
    const catalog = makeCatalog([sink, candidate, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(catalog, indexes, {});
    expect(signals.some((s) => s.message.includes('tsSink'))).toBe(false);
  });

  it('Empty sideEffectPrimitives array falls through to TS fallback regex', () => {
    // Adapter that supplies an empty list — treat as "no hint" so the
    // TS-shaped fallback runs.
    const sink = occ({
      bodyHash: 'sink',
      simpleName: 'sink',
      ...exportedDefaults,
      calls: [ed('console.log("x")', [])],
    });
    const candidate = occ({
      bodyHash: 'cand',
      simpleName: 'fallback',
      ...exportedDefaults,
      calls: [ed('sink()', ['sink']), ed('sink()', ['sink'])],
    });
    const caller = occ({
      bodyHash: 'caller',
      simpleName: 'caller',
      ...exportedDefaults,
      calls: [ed('fallback()', ['cand'], true)],
    });
    const catalog = makeCatalog([sink, candidate, caller]);
    const indexes = buildIndexes(catalog);
    const signals = noSideEffectPathRule.evaluate(
      catalog,
      indexes,
      {},
      { sideEffectPrimitives: [] },
    );
    // TS fallback applied — console.log detected — fallback NOT flagged.
    expect(signals.some((s) => s.message.includes('fallback'))).toBe(false);
  });
});

describe('rule hints — always-throws-branch', () => {
  it('Python hints: matches `raise SomeError(...)` shape', () => {
    const a = occ({
      bodyHash: 'a',
      simpleName: 'pyFail',
      calls: [edge('raise ValueError("nope")'), edge('raise RuntimeError("nope")')],
    });
    const catalog = makeCatalog([a]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {}, pythonRuleHints);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.message).toContain('pyFail');
  });

  it('Python hints: bare `raise` (no identifier) matches the regex', () => {
    const a = occ({
      bodyHash: 'a',
      simpleName: 'rethrow',
      calls: [edge('raise')],
    });
    const catalog = makeCatalog([a]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {}, pythonRuleHints);
    expect(signals).toHaveLength(1);
  });

  it('Rust hints: matches `panic!(...)` shape', () => {
    const a = occ({
      bodyHash: 'a',
      simpleName: 'rsFail',
      calls: [edge('panic!("boom")'), edge('panic!("nope")')],
    });
    const catalog = makeCatalog([a]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {}, rustRuleHints);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.message).toContain('rsFail');
  });

  it('Rust hints: TS `throw new Error(...)` does NOT match Rust regex', () => {
    const a = occ({
      bodyHash: 'a',
      simpleName: 'tsShape',
      calls: [edge('throw new Error("hi")')],
    });
    const catalog = makeCatalog([a]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {}, rustRuleHints);
    // Rust regex doesn't match the TS shape — no signal.
    expect(signals).toHaveLength(0);
  });

  it('Without hints: TS-shaped fallback regex still matches `throw new Error(...)`', () => {
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
  });

  it('Without hints: Python `raise ...` does NOT match TS fallback regex (illustrates F-1)', () => {
    // This is the F-1 finding: a Python project running through the
    // engine without hints would never flag `raise SomeError(...)` as
    // an always-throws helper, because the TS-shaped fallback expects
    // `throw`. The Python hint above closes that gap.
    const a = occ({
      bodyHash: 'a',
      simpleName: 'pyHelper',
      calls: [edge('raise ValueError("x")')],
    });
    const catalog = makeCatalog([a]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(catalog, indexes, {});
    expect(signals).toHaveLength(0);
  });

  it('TypeScript hints: regression check — `throw new Error(...)` still flagged', () => {
    const a = occ({
      bodyHash: 'a',
      simpleName: 'tsFail',
      calls: [edge('throw new Error("boom")'), edge('throw new TypeError("x")')],
    });
    const catalog = makeCatalog([a]);
    const indexes = buildIndexes(catalog);
    const signals = alwaysThrowsBranchRule.evaluate(
      catalog,
      indexes,
      {},
      typescriptGraphAdapter.ruleHints,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.message).toContain('tsFail');
  });
});
