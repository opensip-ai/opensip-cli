/**
 * Branch-coverage tests for lang-python/resolve.ts.
 *
 * Exercises the resolution ladder by feeding small Python fixtures
 * through the full discover/parse/walk/resolve pipeline. Each test
 * targets one of the call-target shapes (identifier, attribute,
 * subscript/lambda) and one rung of the confidence ladder
 * (unknown / static / method-dispatch).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pythonGraphAdapter } from '../index.js';

import type { Catalog, FunctionOccurrence } from '@opensip-tools/graph';

function runPipeline(dir: string): {
  occurrences: Record<string, FunctionOccurrence[]>;
  edgesByOwner: ReadonlyMap<string, readonly { to: readonly string[]; resolution: string; confidence: string; text: string; discarded: boolean }[]>;
  stats: { totalCallSites: number; resolvedHigh: number; resolvedMedium: number; resolvedLow: number; unresolved: number };
} {
  const discovery = pythonGraphAdapter.discoverFiles({ cwd: dir });
  const parsed = pythonGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  const walk = pythonGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'python',
    cacheKey: 'test',
    builtAt: new Date().toISOString(),
    functions: walk.occurrences,
  };
  const resolved = pythonGraphAdapter.resolveCallSites({
    project: parsed.project,
    catalog,
    callSites: walk.callSites,
    projectDirAbs: discovery.projectDirAbs,
    resolutionMode: 'exact',
  });
  return {
    occurrences: walk.occurrences,
    edgesByOwner: resolved.edgesByOwner as ReadonlyMap<string, readonly { to: readonly string[]; resolution: string; confidence: string; text: string; discarded: boolean }[]>,
    stats: resolved.stats,
  };
}

function flattenEdges(
  edgesByOwner: ReadonlyMap<string, readonly { to: readonly string[]; resolution: string; confidence: string; text: string; discarded: boolean }[]>,
): readonly { to: readonly string[]; resolution: string; confidence: string; text: string; discarded: boolean }[] {
  const out: { to: readonly string[]; resolution: string; confidence: string; text: string; discarded: boolean }[] = [];
  for (const edges of edgesByOwner.values()) {
    for (const e of edges) out.push(e);
  }
  return out;
}

describe('lang-python resolve.ts — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-python-resolve-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a direct identifier call to a single static medium-confidence edge', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `def helper(x):\n    return x\n\ndef entry():\n    return helper(1)\n`,
      'utf8',
    );
    const { edgesByOwner, stats } = runPipeline(dir);
    const all = flattenEdges(edgesByOwner);
    const helperCall = all.find((e) => e.text.startsWith('helper('));
    expect(helperCall).toBeDefined();
    expect(helperCall?.resolution).toBe('static');
    expect(helperCall?.confidence).toBe('medium');
    expect(helperCall?.to).toHaveLength(1);
    expect(stats.resolvedMedium).toBeGreaterThan(0);
  });

  it('resolves attribute calls (obj.method()) by attribute name', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `class G:\n    def greet(self, who):\n        return who\n\ndef use():\n    g = G()\n    return g.greet("x")\n`,
      'utf8',
    );
    const { edgesByOwner } = runPipeline(dir);
    const all = flattenEdges(edgesByOwner);
    // g.greet("x") should resolve by attribute name 'greet' to the method
    const greetCall = all.find((e) => e.text.includes('g.greet'));
    expect(greetCall).toBeDefined();
    expect(greetCall?.resolution).toBe('static');
    expect(greetCall?.to).toHaveLength(1);
  });

  it('emits method-dispatch low-confidence when multiple catalog entries share a name', () => {
    writeFileSync(
      join(dir, 'a.py'),
      `class A:\n    def run(self):\n        return 1\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'b.py'),
      `class B:\n    def run(self):\n        return 2\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'use.py'),
      `def use(obj):\n    return obj.run()\n`,
      'utf8',
    );
    const { edgesByOwner, stats } = runPipeline(dir);
    const all = flattenEdges(edgesByOwner);
    const runCall = all.find((e) => e.text.includes('obj.run'));
    expect(runCall).toBeDefined();
    expect(runCall?.resolution).toBe('method-dispatch');
    expect(runCall?.confidence).toBe('low');
    expect(runCall?.to.length).toBeGreaterThanOrEqual(2);
    expect(stats.resolvedLow).toBeGreaterThan(0);
  });

  it('emits unknown/low when calling an unknown name', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `def entry():\n    return missing_name(1)\n`,
      'utf8',
    );
    const { edgesByOwner, stats } = runPipeline(dir);
    const all = flattenEdges(edgesByOwner);
    const missing = all.find((e) => e.text.includes('missing_name'));
    expect(missing).toBeDefined();
    expect(missing?.resolution).toBe('unknown');
    expect(missing?.confidence).toBe('low');
    expect(missing?.to).toHaveLength(0);
    expect(stats.unresolved).toBeGreaterThan(0);
  });

  it('emits unknown for non-identifier/attribute call shapes (lambda IIFE)', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `def entry():\n    return (lambda x: x)(1)\n`,
      'utf8',
    );
    const { edgesByOwner } = runPipeline(dir);
    const all = flattenEdges(edgesByOwner);
    // The (lambda...)(1) is a call whose target is a parenthesized
    // lambda — neither identifier nor attribute → unknown.
    expect(all.some((e) => e.resolution === 'unknown')).toBe(true);
  });

  it('emits unknown for subscript calls (e.g. fns[0]())', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `def entry(fns):\n    return fns[0]()\n`,
      'utf8',
    );
    const { edgesByOwner } = runPipeline(dir);
    const all = flattenEdges(edgesByOwner);
    expect(all.some((e) => e.resolution === 'unknown')).toBe(true);
  });

  it('marks return value as discarded for expression-statement calls', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `def helper(x):\n    return x\n\ndef entry():\n    helper(1)\n    return helper(2)\n`,
      'utf8',
    );
    const { edgesByOwner } = runPipeline(dir);
    const all = flattenEdges(edgesByOwner);
    const helperEdges = all.filter((e) => e.text.startsWith('helper('));
    // One should be discarded (statement-level), one should not (in return)
    expect(helperEdges.some((e) => e.discarded === true)).toBe(true);
    expect(helperEdges.some((e) => e.discarded === false)).toBe(true);
  });

  it('treats parenthesized statement-level calls as discarded', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `def helper():\n    return 1\n\ndef entry():\n    (helper())\n`,
      'utf8',
    );
    const { edgesByOwner } = runPipeline(dir);
    const all = flattenEdges(edgesByOwner);
    const helperEdges = all.filter((e) => e.text.startsWith('helper('));
    expect(helperEdges.some((e) => e.discarded === true)).toBe(true);
  });

  it('treats await-wrapped statement-level calls as discarded', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `async def helper():\n    return 1\n\nasync def entry():\n    await helper()\n`,
      'utf8',
    );
    const { edgesByOwner } = runPipeline(dir);
    const all = flattenEdges(edgesByOwner);
    const helperEdges = all.filter((e) => e.text.startsWith('helper('));
    expect(helperEdges.some((e) => e.discarded === true)).toBe(true);
  });

  it('emits a creation edge for lambdas nested in a parent function', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `def entry():\n    f = lambda n: n + 1\n    return f(2)\n`,
      'utf8',
    );
    const { edgesByOwner, stats } = runPipeline(dir);
    // creation edges record resolution='static' confidence='high' (per
    // pushCreationEdge in @opensip-tools/graph)
    const all = flattenEdges(edgesByOwner);
    expect(all.some((e) => e.resolution === 'static' && e.confidence === 'high')).toBe(true);
    expect(stats.resolvedHigh).toBeGreaterThan(0);
  });

  it('skips synthetic/module-init names from the name index (names starting with <)', () => {
    // <module-init> names start with '<' and should not be lookup targets
    writeFileSync(
      join(dir, 'a.py'),
      `def f():\n    return 1\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'b.py'),
      `def caller():\n    return f()\n`,
      'utf8',
    );
    const { edgesByOwner } = runPipeline(dir);
    const all = flattenEdges(edgesByOwner);
    // The synthetic names like <module-init:a.py> exist as keys in
    // occurrences but should never appear as call targets. Just ensure
    // f() resolves successfully — its presence proves the index works
    // even when synthetic names coexist.
    const fCall = all.find((e) => e.text.startsWith('f('));
    expect(fCall?.resolution).toBe('static');
  });

  it('produces stable stats counters that sum to totalCallSites', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `def known():\n    return 1\n\ndef entry():\n    known()\n    unknown_fn()\n    return 1\n`,
      'utf8',
    );
    const { stats } = runPipeline(dir);
    expect(stats.totalCallSites).toBe(
      stats.resolvedHigh + stats.resolvedMedium + stats.resolvedLow + stats.unresolved,
    );
    expect(stats.totalCallSites).toBeGreaterThanOrEqual(2);
  });
});
