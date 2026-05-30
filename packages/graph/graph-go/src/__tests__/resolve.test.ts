/**
 * Branch-coverage tests for graph-go/resolve.ts.
 *
 * Drives the full Go adapter (discover + parse + walk + resolve)
 * over fixtures exercising:
 *   - `call_expression` with identifier callee (`foo()`)
 *   - selector_expression callees (`obj.Method()`, `pkg.Func()`,
 *     `Type{}.method()`)
 *   - Confidence ladder: 0 → unknown/low; 1 → static/medium;
 *     N → method-dispatch/low
 *   - Unrecognized callee shapes (index expression, type assertion
 *     call) → unresolved
 *   - `defer` and `go` statements → discarded=true
 *   - Closure creation edges → static/high
 *   - I-4: catalog is not mutated
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { goGraphAdapter } from '../index.js';

import type { GoParsedProject } from '../parse.js';
import type { Catalog, CallEdge, ResolveOutput, WalkOutput } from '@opensip-tools/graph';

interface Pipeline {
  readonly project: GoParsedProject;
  readonly walk: WalkOutput;
  readonly catalog: Catalog;
  readonly resolved: ResolveOutput;
}

function pipeline(dir: string): Pipeline {
  const discovery = goGraphAdapter.discoverFiles({ cwd: dir });
  const parsed = goGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  const walk = goGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: goGraphAdapter.id,
    builtAt: '2026-05-27T00:00:00.000Z',
    cacheKey: goGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      configPathAbs: discovery.configPathAbs,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    }),
    functions: walk.occurrences,
  };
  const resolved = goGraphAdapter.resolveCallSites({
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

describe('graph-go resolve.ts', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-go-resolve-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves single-match identifier call as static/medium', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc caller() { callee() }\nfunc callee() {}\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edge = allEdges(resolved).find((e) => e.text.startsWith('callee('));
    expect(edge).toBeDefined();
    expect(edge?.resolution).toBe('static');
    expect(edge?.confidence).toBe('medium');
    expect(edge?.to.length).toBe(1);
    expect(resolved.stats.resolvedMedium).toBeGreaterThan(0);
  });

  it('resolves multi-match identifier call as method-dispatch/low', () => {
    // Two functions with the same simple name (one method, one free
    // function) — name-based resolution sees two matches.
    writeFileSync(
      join(dir, 'main.go'),
      `package main\ntype Foo struct{}\nfunc (f Foo) work() {}\nfunc work() {}\nfunc caller(f Foo) { f.work(); work() }\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edges = allEdges(resolved).filter((e) => e.text.includes('work('));
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.resolution).toBe('method-dispatch');
      expect(e.confidence).toBe('low');
      expect(e.to.length).toBe(2);
    }
    expect(resolved.stats.resolvedLow).toBeGreaterThan(0);
  });

  it('reports unknown/low when no catalog entry matches', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc caller() { unknownFunc() }\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edge = allEdges(resolved).find((e) => e.text.startsWith('unknownFunc('));
    expect(edge).toBeDefined();
    expect(edge?.resolution).toBe('unknown');
    expect(edge?.confidence).toBe('low');
    expect(edge?.to).toEqual([]);
    expect(resolved.stats.unresolved).toBeGreaterThan(0);
  });

  it('resolves selector_expression callees by trailing field name', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\ntype Foo struct{}\nfunc (f Foo) bar() {}\nfunc caller(f Foo) { f.bar() }\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edge = allEdges(resolved).find((e) => e.text === 'f.bar()');
    expect(edge).toBeDefined();
    expect(edge?.resolution).toBe('static');
    expect(edge?.to.length).toBe(1);
  });

  it('treats pkg.Func selector calls the same way (field name lookup)', () => {
    // We can't tell `pkg.Func` from `obj.Method` without type info, so
    // the resolver looks up by the trailing identifier. Here `Println`
    // has no catalog match → unknown.
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nimport "fmt"\nfunc caller() { fmt.Println("hi") }\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edge = allEdges(resolved).find((e) => e.text.startsWith('fmt.Println'));
    expect(edge).toBeDefined();
    expect(edge?.resolution).toBe('unknown');
    expect(edge?.to).toEqual([]);
  });

  it('returns null target when callee is a non-id/non-selector shape (e.g., index expression)', () => {
    // `funcs["foo"]()` — call_expression.function is an index_expression,
    // which the resolver does not recognize → unknown/low.
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc caller(funcs map[string]func()) { funcs["foo"]() }\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edges = allEdges(resolved).filter((e) => e.text.includes('funcs['));
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.resolution).toBe('unknown');
      expect(e.to).toEqual([]);
    }
  });

  it('marks defer call as discarded=true', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc caller() { defer cleanup() }\nfunc cleanup() {}\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edge = allEdges(resolved).find((e) => e.text.startsWith('cleanup('));
    expect(edge).toBeDefined();
    expect(edge?.discarded).toBe(true);
  });

  it('marks go statement call as discarded=true', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc caller() { go worker() }\nfunc worker() {}\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edge = allEdges(resolved).find((e) => e.text.startsWith('worker('));
    expect(edge).toBeDefined();
    expect(edge?.discarded).toBe(true);
  });

  it('marks plain expression-statement call as discarded=true', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc caller() { side() }\nfunc side() {}\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edge = allEdges(resolved).find((e) => e.text.startsWith('side('));
    expect(edge?.discarded).toBe(true);
  });

  it('marks call in assignment context as discarded=false', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc caller() { x := compute(); _ = x }\nfunc compute() int { return 1 }\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edge = allEdges(resolved).find((e) => e.text.startsWith('compute('));
    expect(edge).toBeDefined();
    expect(edge?.discarded).toBe(false);
  });

  it('treats parenthesized_expression transparently when checking discard', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc caller() { (compute()) }\nfunc compute() int { return 1 }\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edge = allEdges(resolved).find((e) => e.text.startsWith('compute('));
    expect(edge).toBeDefined();
    expect(edge?.discarded).toBe(true);
  });

  it('emits a creation edge (static/high) for func_literal closures', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc maker() func(int) int {\n    inc := func(n int) int { return n + 1 }\n    return inc\n}\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const creation = allEdges(resolved).find((e) => e.resolution === 'static' && e.confidence === 'high');
    expect(creation).toBeDefined();
    expect(resolved.stats.resolvedHigh).toBeGreaterThan(0);
  });

  it('I-4 — resolveCallSites does not mutate the input catalog', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc a() { b() }\nfunc b() {}\n`,
      'utf8',
    );
    const { catalog, walk, project } = pipeline(dir);
    const before = JSON.stringify(catalog);
    goGraphAdapter.resolveCallSites({
      project,
      catalog,
      callSites: walk.callSites,
      projectDirAbs: dir,
      resolutionMode: 'exact',
    });
    expect(JSON.stringify(catalog)).toBe(before);
  });

  it('skips synthetic <module-init> entries from the byName index', () => {
    writeFileSync(
      join(dir, 'a.go'),
      `package main\nfunc m() {}\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'b.go'),
      `package main\nfunc m2() {}\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    const edges = allEdges(resolved);
    // No call edge should reference the module-init synthetic name.
    expect(edges.every((e) => !e.text.includes('<module-init>'))).toBe(true);
  });

  it('emits empty edge map when there are no call sites', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc Empty() {}\n`,
      'utf8',
    );
    const { resolved } = pipeline(dir);
    expect(resolved.stats.totalCallSites).toBe(0);
    expect(resolved.edgesByOwner.size).toBe(0);
  });
});
