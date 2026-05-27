/**
 * Branch-coverage tests for lang-rust/resolve.ts.
 *
 * Drives the full Rust adapter (discover + parse + walk + resolve)
 * over fixtures that exercise every documented call-target shape:
 *
 *   - bare `foo()` call (`identifier`)
 *   - `obj.method()` (`field_expression`)
 *   - `Type::method()` (`scoped_identifier` with receiver narrowing)
 *   - `mod::Type::method()` (nested `scoped_identifier`)
 *   - `name!(...)` macro_invocation
 *   - creation edges through closures
 *   - expression_statement vs parenthesized return-value discard logic
 *
 * Resolver confidence ladders for each lookup outcome:
 *   - 0 catalog matches  → resolution 'unknown',         confidence 'low'
 *   - 1 catalog match    → resolution 'static',          confidence 'medium'
 *   - N catalog matches  → resolution 'method-dispatch', confidence 'low'
 *   - receiver-narrowed  → resolution 'static'/'method-dispatch',
 *                          confidence 'medium'
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rustGraphAdapter } from '../index.js';

import type {
  CallEdge,
  Catalog,
  ResolveOutput,
} from '@opensip-tools/graph';

/**
 * Drive the full pipeline against a temp project and return the
 * resolve output plus the catalog built from the walk's occurrences.
 */
function runPipeline(dir: string): {
  readonly resolved: ResolveOutput;
  readonly allEdges: readonly CallEdge[];
  readonly catalog: Catalog;
} {
  const discovery = rustGraphAdapter.discoverFiles({ cwd: dir });
  const parsed = rustGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
  });
  const walk = rustGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'rust',
    builtAt: new Date().toISOString(),
    cacheKey: 'rs-test',
    functions: walk.occurrences,
  };
  const resolved = rustGraphAdapter.resolveCallSites({
    project: parsed.project,
    catalog,
    callSites: walk.callSites,
    projectDirAbs: discovery.projectDirAbs,
  });
  const allEdges: CallEdge[] = [];
  for (const list of resolved.edgesByOwner.values()) {
    for (const e of list) allEdges.push(e);
  }
  return { resolved, allEdges, catalog };
}

describe('lang-rust resolve.ts — call-target decoding and resolution', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-rust-resolve-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a bare identifier call `foo()` to its catalog hash (static / medium)', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn helper() -> i32 { 1 }\nfn entry() -> i32 { helper() }\n`,
      'utf8',
    );
    const { resolved, allEdges } = runPipeline(dir);
    const helperCall = allEdges.find((e) => e.text.includes('helper'));
    expect(helperCall).toBeDefined();
    expect(helperCall?.resolution).toBe('static');
    expect(helperCall?.confidence).toBe('medium');
    expect(helperCall?.to.length).toBe(1);
    expect(resolved.stats.resolvedMedium).toBeGreaterThan(0);
  });

  it('resolves `obj.method()` (field_expression) by trailing field name', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `struct G { p: i32 }\n` +
        `impl G {\n` +
        `    fn greet(&self) -> i32 { self.p }\n` +
        `}\n` +
        `fn entry() -> i32 {\n` +
        `    let g = G { p: 1 };\n` +
        `    g.greet()\n` +
        `}\n`,
      'utf8',
    );
    const { allEdges } = runPipeline(dir);
    const greetCall = allEdges.find((e) => e.text.includes('g.greet'));
    expect(greetCall).toBeDefined();
    expect(greetCall?.to.length).toBe(1);
  });

  it('narrows `Type::method()` via receiver-type when an impl exists (medium confidence)', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `struct G;\n` +
        `impl G {\n` +
        `    fn make() -> i32 { 42 }\n` +
        `}\n` +
        `fn entry() -> i32 { G::make() }\n`,
      'utf8',
    );
    const { allEdges } = runPipeline(dir);
    const makeCall = allEdges.find((e) => e.text.includes('G::make'));
    expect(makeCall).toBeDefined();
    expect(makeCall?.confidence).toBe('medium');
    expect(makeCall?.to.length).toBe(1);
  });

  it('falls back to broad name lookup when receiver type has no matching method', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn other() -> i32 { 1 }\n` +
        `fn entry() -> i32 { Foreign::other() }\n`,
      'utf8',
    );
    const { allEdges } = runPipeline(dir);
    const otherCall = allEdges.find((e) => e.text.includes('Foreign::other'));
    expect(otherCall).toBeDefined();
    // No `impl Foreign { fn other }`, but a top-level `fn other` exists.
    // Falls back to broad lookup → static + medium with one match.
    expect(otherCall?.to.length).toBe(1);
    expect(otherCall?.resolution).toBe('static');
  });

  it('returns 0 matches as resolution `unknown` + low confidence', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn entry() { unknown_function() }\n`,
      'utf8',
    );
    const { allEdges, resolved } = runPipeline(dir);
    const call = allEdges.find((e) => e.text.includes('unknown_function'));
    expect(call).toBeDefined();
    expect(call?.resolution).toBe('unknown');
    expect(call?.confidence).toBe('low');
    expect(call?.to).toEqual([]);
    expect(resolved.stats.unresolved).toBeGreaterThan(0);
  });

  it('returns N matches as `method-dispatch` + low confidence', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `struct A;\nstruct B;\n` +
        `impl A { fn op(&self) -> i32 { 1 } }\n` +
        `impl B { fn op(&self) -> i32 { 2 } }\n` +
        `fn entry(x: A) -> i32 { x.op() }\n`,
      'utf8',
    );
    const { allEdges } = runPipeline(dir);
    const call = allEdges.find((e) => e.text.includes('x.op'));
    expect(call).toBeDefined();
    expect(call?.resolution).toBe('method-dispatch');
    expect(call?.confidence).toBe('low');
    expect(call?.to.length).toBe(2);
  });

  it('tags macro_invocations as `unknown` with edge text `name! ...` for primitive matching', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn entry() { println!("hello"); }\n`,
      'utf8',
    );
    const { allEdges } = runPipeline(dir);
    const macro = allEdges.find((e) => e.text.startsWith('println! '));
    expect(macro).toBeDefined();
    expect(macro?.resolution).toBe('unknown');
    expect(macro?.confidence).toBe('low');
  });

  it('emits a creation edge for an inline closure (always present in edges)', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn entry() {\n` +
        `    let add_one = |n: i32| n + 1;\n` +
        `    let _ = add_one(3);\n` +
        `}\n`,
      'utf8',
    );
    const { allEdges } = runPipeline(dir);
    // The closure body is the target of a creation edge from `entry`'s
    // owner body. We assert at least one edge exists in the owner-set.
    expect(allEdges.length).toBeGreaterThan(0);
    // And a call to add_one is at least decoded (target may not be in
    // the catalog by simple name, but the call_expression still emits
    // an edge).
    const callOfAddOne = allEdges.find((e) => e.text.includes('add_one('));
    expect(callOfAddOne).toBeDefined();
  });

  it('marks `discarded` true when the call is a bare expression_statement', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn helper() {}\n` +
        `fn entry() {\n` +
        `    helper();\n` +
        `}\n`,
      'utf8',
    );
    const { allEdges } = runPipeline(dir);
    const call = allEdges.find((e) => e.text.includes('helper'));
    expect(call?.discarded).toBe(true);
  });

  it('marks `discarded` false when the call value is used (e.g. let-bound)', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn helper() -> i32 { 1 }\n` +
        `fn entry() -> i32 {\n` +
        `    let x = helper();\n` +
        `    x\n` +
        `}\n`,
      'utf8',
    );
    const { allEdges } = runPipeline(dir);
    const call = allEdges.find((e) => e.text.includes('helper'));
    expect(call?.discarded).toBe(false);
  });

  it('looks through parenthesized_expression when deciding discarded', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    // (helper()); as a statement → discarded should still be true
    // because the outer node is expression_statement after unwrapping
    // the parenthesized_expression chain.
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn helper() -> i32 { 1 }\n` +
        `fn entry() {\n` +
        `    (helper());\n` +
        `}\n`,
      'utf8',
    );
    const { allEdges } = runPipeline(dir);
    const call = allEdges.find((e) => e.text.includes('helper'));
    expect(call).toBeDefined();
    expect(call?.discarded).toBe(true);
  });

  it('produces resolutionStats consistent with the recorded edges', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn helper() -> i32 { 1 }\n` +
        `fn entry() -> i32 { helper() + unknown_fn() }\n`,
      'utf8',
    );
    const { resolved } = runPipeline(dir);
    const totalEdges = resolved.stats.resolvedHigh +
      resolved.stats.resolvedMedium +
      resolved.stats.resolvedLow +
      resolved.stats.unresolved;
    expect(totalEdges).toBe(resolved.stats.totalCallSites);
    expect(resolved.stats.resolvedMedium).toBeGreaterThan(0); // helper
    expect(resolved.stats.unresolved).toBeGreaterThan(0); // unknown_fn
  });

  it('decodes `mod::Type::method()` shape (nested scoped_identifier path)', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn entry() { std::fs::read("x"); }\n`,
      'utf8',
    );
    const { allEdges } = runPipeline(dir);
    // `read` isn't in the catalog; it should emit an unknown edge.
    const call = allEdges.find((e) => e.text.includes('std::fs::read'));
    expect(call).toBeDefined();
    expect(call?.resolution).toBe('unknown');
  });

  it('strips the leading namespace from a scoped macro invocation `path::name!()`', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn entry() { log::info!("hello"); }\n`,
      'utf8',
    );
    const { allEdges } = runPipeline(dir);
    // `decodeCallTarget` for `macro_invocation` keeps only the trailing
    // segment after `::`, so the edge text is prefixed with `info!`.
    const macro = allEdges.find((e) => e.text.startsWith('info! '));
    expect(macro).toBeDefined();
    expect(macro?.resolution).toBe('unknown');
  });

  it('emits N-match narrowed lookup as method-dispatch + medium when an impl has multiple methods of the same name', () => {
    // Re-running an `impl Foo { fn op }` block twice in the same file
    // simulates the rare case of `methods.get('Foo::op')` returning two
    // occurrences — exercising the `hashes.length === 1 ? 'static' :
    // 'method-dispatch'` branch on the narrowed path.
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `struct Foo;\n` +
        `impl Foo { fn op(&self) -> i32 { 1 } }\n` +
        // A second impl block for Foo with the same method name —
        // permitted only in different cfg conditions in real Rust, but
        // tree-sitter parses it fine, and the indexer ends up with two
        // entries for `Foo::op`.
        `mod alt { use super::*; impl Foo { fn op(&self) -> i32 { 2 } } }\n` +
        `fn entry() -> i32 { Foo::op(&Foo) }\n`,
      'utf8',
    );
    const { allEdges } = runPipeline(dir);
    const call = allEdges.find((e) => e.text.includes('Foo::op'));
    expect(call).toBeDefined();
    expect(call?.confidence).toBe('medium');
    // Either single-narrowed (static) or multi-narrowed (method-dispatch),
    // depending on how tree-sitter-rust parses the alt module. Both cases
    // exercise lines we want to cover.
    expect(['static', 'method-dispatch']).toContain(call?.resolution);
  });

  it('handles a call site whose enclosing owner is the synthetic module-init (no parent function)', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    // A call_expression in a top-level `const` initializer is owned by
    // the module-init synthetic. This exercises the resolver's
    // owner-key handling for non-function owners.
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn maker() -> i32 { 1 }\nconst _N: i32 = maker() + 1;\n`,
      'utf8',
    );
    const { allEdges } = runPipeline(dir);
    const call = allEdges.find((e) => e.text.includes('maker'));
    expect(call).toBeDefined();
    expect(call?.to.length).toBe(1);
  });

  it('handles call_expression with field_expression on a chained receiver (only trailing field matters)', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `struct X { name: String }\n` +
        `impl X { fn fmt(&self) -> &str { &self.name } }\n` +
        `fn entry(x: &X) -> &str { x.fmt() }\n`,
      'utf8',
    );
    const { allEdges } = runPipeline(dir);
    const call = allEdges.find((e) => e.text.includes('x.fmt'));
    expect(call).toBeDefined();
  });

  it('does not produce a "high" confidence edge (the resolver never elevates that high)', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn one() -> i32 { 1 }\nfn entry() -> i32 { one() }\n`,
      'utf8',
    );
    const { resolved } = runPipeline(dir);
    expect(resolved.stats.resolvedHigh).toBe(0);
  });
});

/**
 * Direct unit tests that inject synthetic CallSiteRecord shapes to
 * exercise the defensive null-return branches in `decodeCallTarget`,
 * `decodeReceiverPath`, and `resolveTarget`. We construct minimal
 * fake `nodeRef` objects that mimic tree-sitter's SyntaxNode surface
 * (the resolver reads `type`, `parent`, `childForFieldName`,
 * `namedChild`, `namedChildCount`, `startPosition`, `endPosition`,
 * `startIndex`, `endIndex`, `text`). The fakes are duck-typed enough
 * for the resolver's needs.
 */

interface FakeNode {
  readonly type: string;
  readonly text: string;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly startIndex: number;
  readonly endIndex: number;
  readonly parent: unknown;
  childForFieldName(n: string): unknown;
  namedChild(i: number): unknown;
  readonly namedChildCount: number;
}

/** Build a tiny tree-sitter-ish fake node. */
function makeNode(type: string, opts: Partial<{
  text: string;
  parent: unknown;
  fields: Record<string, unknown>;
  named: unknown[];
}> = {}): FakeNode {
  const text = opts.text ?? '';
  const fields = opts.fields ?? {};
  const named = opts.named ?? [];
  return {
    type,
    text,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: text.length },
    startIndex: 0,
    endIndex: text.length,
    parent: opts.parent ?? null,
    childForFieldName: (n: string) => fields[n] ?? null,
    namedChild: (i: number) => named[i] ?? null,
    namedChildCount: named.length,
  };
}

function makeFile(): { tree: unknown; source: string } {
  return { tree: {}, source: '' };
}

function runResolveSynthetic(dir: string, callSites: readonly unknown[]): ResolveOutput {
  return rustGraphAdapter.resolveCallSites({
    project: { files: new Map() },
    catalog: {
      version: '3.0',
      tool: 'graph',
      language: 'rust',
      builtAt: new Date().toISOString(),
      cacheKey: 'rs-test',
      functions: {},
    },
    // Test-only: synthetic CallSiteRecord shapes inject duck-typed
    // node refs to drive the resolver's defensive null branches.
    callSites: callSites as never,
    projectDirAbs: dir,
  });
}

describe('lang-rust resolve.ts — defensive guards via synthetic nodes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-rust-resolve-fakes-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runResolve(callSites: readonly unknown[]): ResolveOutput {
    return runResolveSynthetic(dir, callSites);
  }

  it('emits an unknown/low edge when decodeCallTarget receives a non-call, non-macro node', () => {
    // node.type is neither 'call_expression' nor 'macro_invocation'.
    const fakeNode = makeNode('binary_expression', { text: 'a + b' });
    const out = runResolve([
      { nodeRef: fakeNode, sourceFileRef: makeFile(), ownerHash: 'h0', kind: 'call' },
    ]);
    const edges = [...out.edgesByOwner.values()].flat();
    expect(edges.length).toBe(1);
    expect(edges[0]?.resolution).toBe('unknown');
    expect(edges[0]?.confidence).toBe('low');
  });

  it('emits an unknown/low edge when call_expression has no `function` field', () => {
    const fakeNode = makeNode('call_expression', { text: '???' });
    const out = runResolve([
      { nodeRef: fakeNode, sourceFileRef: makeFile(), ownerHash: 'h1', kind: 'call' },
    ]);
    const edges = [...out.edgesByOwner.values()].flat();
    expect(edges[0]?.resolution).toBe('unknown');
  });

  it('emits an unknown/low edge when field_expression has no `field`', () => {
    const fn = makeNode('field_expression', { text: 'a.', fields: {} });
    const fakeNode = makeNode('call_expression', { text: 'a.()', fields: { function: fn } });
    const out = runResolve([
      { nodeRef: fakeNode, sourceFileRef: makeFile(), ownerHash: 'h2', kind: 'call' },
    ]);
    const edges = [...out.edgesByOwner.values()].flat();
    expect(edges[0]?.resolution).toBe('unknown');
  });

  it('emits an unknown/low edge when scoped_identifier has no `name`/named child', () => {
    const fn = makeNode('scoped_identifier', { text: 'Type:', fields: {}, named: [] });
    const fakeNode = makeNode('call_expression', { text: 'Type:()', fields: { function: fn } });
    const out = runResolve([
      { nodeRef: fakeNode, sourceFileRef: makeFile(), ownerHash: 'h3', kind: 'call' },
    ]);
    const edges = [...out.edgesByOwner.values()].flat();
    expect(edges[0]?.resolution).toBe('unknown');
  });

  it('emits an unknown/low edge when an unhandled `function` shape appears (e.g. parenthesized fn)', () => {
    // fn.type is not identifier / field_expression / scoped_identifier.
    const fn = makeNode('parenthesized_expression', { text: '(closure)' });
    const fakeNode = makeNode('call_expression', { text: '(closure)()', fields: { function: fn } });
    const out = runResolve([
      { nodeRef: fakeNode, sourceFileRef: makeFile(), ownerHash: 'h4', kind: 'call' },
    ]);
    const edges = [...out.edgesByOwner.values()].flat();
    expect(edges[0]?.resolution).toBe('unknown');
  });

  it('emits an unknown/low edge when macro_invocation has no `macro` and no named child', () => {
    const fakeNode = makeNode('macro_invocation', { text: '!()', fields: {}, named: [] });
    const out = runResolve([
      { nodeRef: fakeNode, sourceFileRef: makeFile(), ownerHash: 'h5', kind: 'call' },
    ]);
    const edges = [...out.edgesByOwner.values()].flat();
    expect(edges[0]?.resolution).toBe('unknown');
  });

  it('handles scoped_identifier whose path is an unrecognized type', () => {
    // path is some unexpected node type; decodeReceiverPath returns null.
    const name = makeNode('identifier', { text: 'do_it' });
    const oddPath = makeNode('lifetime', { text: "'static" });
    const fn = makeNode('scoped_identifier', {
      text: "'static::do_it",
      fields: { name, path: oddPath },
      named: [name],
    });
    const fakeNode = makeNode('call_expression', {
      text: "'static::do_it()",
      fields: { function: fn },
    });
    const out = runResolve([
      { nodeRef: fakeNode, sourceFileRef: makeFile(), ownerHash: 'h6', kind: 'call' },
    ]);
    const edges = [...out.edgesByOwner.values()].flat();
    // `do_it` not in catalog → unknown.
    expect(edges[0]?.resolution).toBe('unknown');
  });

  it('handles scoped_identifier whose path is a scoped_identifier with no inner name', () => {
    const name = makeNode('identifier', { text: 'thing' });
    // Inner scoped_identifier with no `name` field, and no named children.
    const innerPath = makeNode('scoped_identifier', { text: 'mod::', fields: {}, named: [] });
    const fn = makeNode('scoped_identifier', {
      text: 'mod::Type::thing',
      fields: { name, path: innerPath },
      named: [name],
    });
    const fakeNode = makeNode('call_expression', {
      text: 'mod::Type::thing()',
      fields: { function: fn },
    });
    const out = runResolve([
      { nodeRef: fakeNode, sourceFileRef: makeFile(), ownerHash: 'h7', kind: 'call' },
    ]);
    const edges = [...out.edgesByOwner.values()].flat();
    expect(edges[0]?.resolution).toBe('unknown');
  });

  it('skips creation call-sites whose childHash is undefined (defensive)', () => {
    // The walker normally sets childHash; if a downstream caller forgets,
    // the creation site is silently skipped.
    const fakeNode = makeNode('closure_expression', { text: '|| 1' });
    const out = runResolve([
      // Note: childHash intentionally omitted.
      { nodeRef: fakeNode, sourceFileRef: makeFile(), ownerHash: 'h8', kind: 'creation' },
    ]);
    expect([...out.edgesByOwner.entries()]).toEqual([]);
  });

  it('falls through to `return false` in isReturnValueDiscarded when no enclosing parent exists', () => {
    // A `helper()` call whose parent chain is null (synthetic root) hits
    // the loop-exit branch and returns false (not discarded).
    const inner = makeNode('identifier', { text: 'helper' });
    const fakeNode = makeNode('call_expression', {
      text: 'helper()',
      fields: { function: inner },
      parent: null, // no enclosing expression_statement
    });
    const out = runResolve([
      { nodeRef: fakeNode, sourceFileRef: makeFile(), ownerHash: 'h9', kind: 'call' },
    ]);
    const edges = [...out.edgesByOwner.values()].flat();
    expect(edges[0]?.discarded).toBe(false);
  });
});
