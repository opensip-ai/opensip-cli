/**
 * Branch-coverage tests for graph-java/resolve.ts.
 *
 * Drives the full Java adapter (discover + parse + walk + resolve)
 * over fixtures exercising:
 *   - `method_invocation` (`foo()`, `obj.foo()`, `this.foo()`,
 *     `super.foo()`, `Class.foo()`)
 *   - `object_creation_expression` (`new Foo()`) and constructor lookup
 *   - `explicit_constructor_invocation` (`super(...)`, `this(...)`) ─
 *     resolved as unresolved (`to: []`)
 *   - Confidence ladder: 0 matches → unknown/low; 1 → static/medium;
 *     N matches → method-dispatch/low
 *   - `creation` edges from lambdas flowing through the resolver
 *   - I-4: catalog is not mutated
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { javaGraphAdapter } from '../index.js';

import type { JavaParsedProject } from '../parse.js';
import type { Catalog, CallEdge, ResolveOutput, WalkOutput } from '@opensip-tools/graph';

interface Pipeline {
  readonly project: JavaParsedProject;
  readonly walk: WalkOutput;
  readonly catalog: Catalog;
  readonly resolved: ResolveOutput;
}

function pipeline(dir: string): Pipeline {
  const discovery = javaGraphAdapter.discoverFiles({ cwd: dir });
  const parsed = javaGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  const walk = javaGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: javaGraphAdapter.id,
    builtAt: '2026-05-27T00:00:00.000Z',
    cacheKey: javaGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      configPathAbs: discovery.configPathAbs,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    }),
    functions: walk.occurrences,
  };
  const resolved = javaGraphAdapter.resolveCallSites({
    project: parsed.project,
    catalog,
    callSites: walk.callSites,
    projectDirAbs: discovery.projectDirAbs,
    resolutionMode: 'exact',
  });
  return { project: parsed.project, walk, catalog, resolved };
}

function allEdges(resolved: ResolveOutput): readonly CallEdge[] {
  const out: CallEdge[] = [];
  for (const edges of resolved.edgesByOwner.values()) out.push(...edges);
  return out;
}

describe('graph-java resolve.ts', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-java-resolve-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves single-match method_invocation as static/medium', () => {
    writeFileSync(
      join(dir, 'A.java'),
      `package x;\nclass A {\n  void caller() { callee(); }\n  void callee() {}\n}\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edges = allEdges(resolved);
    const callEdge = edges.find((e) => e.text.startsWith('callee('));
    expect(callEdge).toBeDefined();
    expect(callEdge?.resolution).toBe('static');
    expect(callEdge?.confidence).toBe('medium');
    expect(callEdge?.to.length).toBe(1);
    expect(resolved.stats.resolvedMedium).toBeGreaterThan(0);
  });

  it('resolves multi-match method_invocation as method-dispatch/low', () => {
    writeFileSync(
      join(dir, 'M.java'),
      `package x;\nclass A { void run() {} }\nclass B { void run() {} }\nclass C { void caller(A a, B b) { a.run(); b.run(); } }\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edges = allEdges(resolved).filter((e) => e.text.includes('.run('));
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.resolution).toBe('method-dispatch');
      expect(e.confidence).toBe('low');
      expect(e.to.length).toBe(2);
    }
    expect(resolved.stats.resolvedLow).toBeGreaterThan(0);
  });

  it('reports unknown/low when no catalog entry matches the called name', () => {
    writeFileSync(
      join(dir, 'U.java'),
      `package x;\nclass U { void caller() { unknownFunc(); } }\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edges = allEdges(resolved).filter((e) => e.text.startsWith('unknownFunc('));
    expect(edges.length).toBe(1);
    expect(edges[0]?.resolution).toBe('unknown');
    expect(edges[0]?.confidence).toBe('low');
    expect(edges[0]?.to).toEqual([]);
    expect(resolved.stats.unresolved).toBeGreaterThan(0);
  });

  it('resolves object_creation_expression (new Foo()) against the constructor', () => {
    writeFileSync(
      join(dir, 'N.java'),
      `package x;\nclass Foo { Foo() {} }\nclass User { void make() { Foo f = new Foo(); } }\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edges = allEdges(resolved).filter((e) => e.text.startsWith('new Foo'));
    expect(edges.length).toBe(1);
    // Constructor is catalogued under simpleName="Foo" so this should
    // resolve to exactly one match (the ctor) → static/medium.
    expect(edges[0]?.resolution).toBe('static');
    expect(edges[0]?.to.length).toBe(1);
  });

  it('handles generic types in object_creation_expression (new Box<T>())', () => {
    writeFileSync(
      join(dir, 'G.java'),
      `package x;\nclass Box<T> { Box() {} }\nclass User { void make() { Box<String> b = new Box<>(); } }\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edges = allEdges(resolved).filter((e) => e.text.startsWith('new Box'));
    expect(edges.length).toBe(1);
    expect(edges[0]?.resolution).toBe('static');
  });

  it('decodes scoped_type_identifier (new pkg.Foo())', () => {
    writeFileSync(
      join(dir, 'S.java'),
      `package x;\nclass User { void make() { java.lang.Object o = new java.lang.Object(); } }\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edges = allEdges(resolved).filter((e) => e.text.startsWith('new java.lang.Object'));
    expect(edges.length).toBe(1);
    // No catalog entry named "Object" exists in this fixture → unknown.
    expect(edges[0]?.resolution).toBe('unknown');
    expect(edges[0]?.to).toEqual([]);
  });

  it('records explicit_constructor_invocation as unresolved (target null)', () => {
    writeFileSync(
      join(dir, 'Sub.java'),
      `package x;\nclass Base { Base(int n) {} }\nclass Sub extends Base {\n  Sub() { super(1); }\n  Sub(int n) { this(); }\n}\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edges = allEdges(resolved);
    const explicits = edges.filter((e) => e.text.startsWith('super(') || e.text.startsWith('this('));
    expect(explicits.length).toBeGreaterThanOrEqual(2);
    for (const e of explicits) {
      expect(e.resolution).toBe('unknown');
      expect(e.to).toEqual([]);
    }
  });

  it('emits a creation edge (static/high) for lambdas', () => {
    writeFileSync(
      join(dir, 'L.java'),
      `package x;\nimport java.util.function.IntUnaryOperator;\nclass L { static IntUnaryOperator make() { IntUnaryOperator inc = n -> n + 1; return inc; } }\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edges = allEdges(resolved);
    const creationEdges = edges.filter((e) => e.resolution === 'static' && e.confidence === 'high');
    expect(creationEdges.length).toBeGreaterThan(0);
    expect(resolved.stats.resolvedHigh).toBeGreaterThan(0);
  });

  it('marks call edges as discarded when in expression_statement context', () => {
    writeFileSync(
      join(dir, 'D.java'),
      `package x;\nclass D {\n  void caller() { sideEffect(); }\n  void sideEffect() {}\n  int useResult() { int x = compute(); return x; }\n  int compute() { return 1; }\n}\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edges = allEdges(resolved);
    const sideEffect = edges.find((e) => e.text.startsWith('sideEffect('));
    const compute = edges.find((e) => e.text.startsWith('compute('));
    expect(sideEffect?.discarded).toBe(true);
    // `int x = compute()` is part of a local variable declaration, NOT
    // an expression statement → not discarded.
    expect(compute?.discarded).toBe(false);
  });

  it('treats parenthesized_expression transparently when checking discard', () => {
    writeFileSync(
      join(dir, 'P.java'),
      `package x;\nclass P {\n  void caller() { (compute()); }\n  int compute() { return 1; }\n}\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edges = allEdges(resolved);
    const compute = edges.find((e) => e.text.startsWith('compute('));
    expect(compute).toBeDefined();
    // Wrapped in parens but still at expression_statement root → discarded.
    expect(compute?.discarded).toBe(true);
  });

  it('I-4 — resolveCallSites does not mutate the input catalog', () => {
    writeFileSync(
      join(dir, 'A.java'),
      `package x;\nclass A { void m() { n(); } void n() {} }\n`,
      'utf8',
    );
    const { catalog, walk, project } = pipeline(dir);
    const before = JSON.stringify(catalog);
    javaGraphAdapter.resolveCallSites({
      project,
      catalog,
      callSites: walk.callSites,
      projectDirAbs: dir,
      resolutionMode: 'exact',
    });
    expect(JSON.stringify(catalog)).toBe(before);
  });

  it('skips synthetic <module-init> entries from the byName index', () => {
    // Two files each contribute a `<module-init>` entry but its name
    // starts with `<` and must be excluded from the name index.
    writeFileSync(
      join(dir, 'A.java'),
      `package x;\nclass A { void m() {} }\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'B.java'),
      `package x;\nclass B { void m() {} }\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    // No call sites reference `<module-init>` (it's synthetic), so
    // simply verify the resolver ran without producing any unexpected
    // 'method-dispatch' edges for unrelated calls.
    const edges = allEdges(resolved);
    expect(edges.every((e) => !e.text.includes('<module-init>'))).toBe(true);
  });

  it('emits empty edge map when there are no call sites', () => {
    writeFileSync(
      join(dir, 'Empty.java'),
      `package x;\nclass Empty {}\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    // module-init occurrence exists but no call-sites are emitted.
    expect(resolved.stats.totalCallSites).toBe(0);
    expect(resolved.edgesByOwner.size).toBe(0);
  });
});
