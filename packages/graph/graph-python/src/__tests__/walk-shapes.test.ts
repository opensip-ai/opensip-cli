/**
 * Function/parameter-shape coverage tests for lang-python/walk.ts.
 *
 * Specifically targets:
 *   - Typed parameters / default parameters / typed-default parameters.
 *   - Methods inside classes (kind: 'method').
 *   - `__init__` (kind: 'constructor').
 *   - Lambdas as siblings of a function (visited but not nested in a
 *     function frame).
 *   - Test-file detection (tests/ folder + test_*.py + _test.py).
 *   - Generated-file detection (dist/, build/, .generated.).
 *   - Visibility ('exported' vs 'module-local').
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pythonGraphAdapter } from '../index.js';
import { isTestFile } from '../walk.js';

function runWalk(dir: string): ReturnType<typeof pythonGraphAdapter.walkProject> {
  const discovery = pythonGraphAdapter.discoverFiles({ cwd: dir });
  const parsed = pythonGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  return pythonGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
}

describe('lang-python walk.ts — function/param shapes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-python-shapes-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('extracts typed, default, and typed-default parameters', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `def f(x: int, y=1, z: str = "a", *args, **kwargs):\n    return (x, y, z, args, kwargs)\n`,
      'utf8',
    );
    const walk = runWalk(dir);
    const f = walk.occurrences.f?.[0];
    expect(f).toBeDefined();
    const names = f?.params.map((p) => p.name) ?? [];
    expect(names).toContain('x');
    expect(names).toContain('y');
    expect(names).toContain('z');
    // typed_default → optional
    const z = f?.params.find((p) => p.name === 'z');
    expect(z?.optional).toBe(true);
    // default_parameter → optional
    const y = f?.params.find((p) => p.name === 'y');
    expect(y?.optional).toBe(true);
    // typed_parameter (no default) → required
    const x = f?.params.find((p) => p.name === 'x');
    expect(x?.optional).toBe(false);
  });

  it('classifies methods and __init__ correctly', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `class C:\n    def __init__(self, p):\n        self.p = p\n\n    def m(self):\n        return self.p\n`,
      'utf8',
    );
    const walk = runWalk(dir);
    const init = walk.occurrences.__init__?.[0];
    const m = walk.occurrences.m?.[0];
    expect(init?.kind).toBe('constructor');
    expect(init?.enclosingClass).toBe('C');
    expect(m?.kind).toBe('method');
    expect(m?.enclosingClass).toBe('C');
  });

  it('marks names starting with underscore as module-local visibility', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `def _private():\n    return 1\n\ndef public():\n    return 2\n`,
      'utf8',
    );
    const walk = runWalk(dir);
    expect(walk.occurrences._private?.[0]?.visibility).toBe('module-local');
    expect(walk.occurrences.public?.[0]?.visibility).toBe('exported');
  });

  it('records a lambda occurrence with arrow kind and creation edge to enclosing function', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `def outer():\n    f = lambda n: n + 1\n    return f(2)\n`,
      'utf8',
    );
    const walk = runWalk(dir);
    const arrowNames = Object.keys(walk.occurrences).filter((k) => k.startsWith('<arrow:'));
    expect(arrowNames.length).toBe(1);
    const arrow = walk.occurrences[arrowNames[0]]?.[0];
    expect(arrow?.kind).toBe('arrow');
    // The lambda's params field comes from extractParamsFromField('parameters')
    expect(arrow?.params.map((p) => p.name)).toContain('n');
    // A creation call site should be recorded for the lambda
    const creation = walk.callSites.find((c) => c.kind === 'creation');
    expect(creation).toBeDefined();
    expect(creation?.childHash).toBe(arrow?.bodyHash);
  });

  it('treats lambdas at module scope as their own owner (no creation edge to themselves)', () => {
    // Lambda assigned at module level: parent frame is module-init.
    // The creation edge IS emitted because module-init's bodyHash !=
    // the lambda's bodyHash.
    writeFileSync(join(dir, 'main.py'), `add = lambda a, b: a + b\n`, 'utf8');
    const walk = runWalk(dir);
    const arrowNames = Object.keys(walk.occurrences).filter((k) => k.startsWith('<arrow:'));
    expect(arrowNames.length).toBe(1);
    const creation = walk.callSites.find((c) => c.kind === 'creation');
    expect(creation).toBeDefined();
  });

  it('flags tests/ files as inTestFile', () => {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests/test_foo.py'), `def test_a():\n    assert True\n`, 'utf8');
    const walk = runWalk(dir);
    const a = walk.occurrences.test_a?.[0];
    expect(a?.inTestFile).toBe(true);
  });

  it('flags _test.py files as inTestFile', () => {
    writeFileSync(join(dir, 'foo_test.py'), `def t():\n    assert True\n`, 'utf8');
    const walk = runWalk(dir);
    const t = walk.occurrences.t?.[0];
    expect(t?.inTestFile).toBe(true);
  });

  it('flags .generated. files as definedInGenerated', () => {
    writeFileSync(join(dir, 'foo.generated.py'), `def x():\n    return 1\n`, 'utf8');
    const walk = runWalk(dir);
    const x = walk.occurrences.x?.[0];
    expect(x?.definedInGenerated).toBe(true);
  });

  it('includes synthetic <module-init> occurrence for each file', () => {
    writeFileSync(join(dir, 'a.py'), `def foo():\n    return 1\n`, 'utf8');
    const walk = runWalk(dir);
    const moduleInitKeys = Object.keys(walk.occurrences).filter((k) =>
      k.startsWith('<module-init:'),
    );
    expect(moduleInitKeys.length).toBe(1);
    const moduleInit = walk.occurrences[moduleInitKeys[0]]?.[0];
    expect(moduleInit?.kind).toBe('module-init');
    expect(moduleInit?.line).toBe(1);
  });

  it('skips files in input.files that are missing from project.files', () => {
    writeFileSync(join(dir, 'a.py'), `def f():\n    return 1\n`, 'utf8');
    const discovery = pythonGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = pythonGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    });
    // Pass an extra file that wasn't parsed — walkProject should skip it.
    const walk = pythonGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: [...discovery.files, join(dir, 'nonexistent.py')],
    });
    expect(Object.keys(walk.occurrences)).toContain('f');
    expect(walk.parseErrors).toEqual([]);
  });

  it('exposes isTestFile predicate that detects tests/ paths and test_*.py / _test.py names', () => {
    expect(isTestFile('tests/test_a.py')).toBe(true);
    expect(isTestFile('src/test_foo.py')).toBe(true);
    expect(isTestFile('src/foo_test.py')).toBe(true);
    expect(isTestFile('src/foo.py')).toBe(false);
    expect(isTestFile('test/foo.py')).toBe(true); // singular `test/` matches /tests?\//
  });
});
