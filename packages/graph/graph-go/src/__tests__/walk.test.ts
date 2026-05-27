/**
 * Branch-coverage tests for graph-go/walk.ts.
 *
 * Drives the full Go adapter (discover + parse + walk) over fixtures
 * exercising: line comments, block comments, interpreted strings,
 * raw strings, function declarations, method declarations (pointer
 * and value receivers), and func_literal (closure) emission.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { goGraphAdapter } from '../index.js';

function run(dir: string): ReturnType<typeof goGraphAdapter.walkProject> {
  const discovery = goGraphAdapter.discoverFiles({ cwd: dir });
  const parsed = goGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
  });
  return goGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
}

describe('graph-go walk.ts', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-go-walk-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits function-declaration for top-level funcs', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc topLevel() int { return 1 }\n`,
      'utf8',
    );
    const walk = run(dir);
    expect(Object.keys(walk.occurrences)).toContain('topLevel');
    const occs = walk.occurrences.topLevel;
    expect(occs?.[0]?.kind).toBe('function-declaration');
    expect(occs?.[0]?.enclosingClass).toBeNull();
  });

  it('emits method with enclosingClass set to receiver type (value receiver)', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\ntype Foo struct{}\nfunc (f Foo) bar() int { return 1 }\n`,
      'utf8',
    );
    const walk = run(dir);
    const bar = walk.occurrences.bar;
    expect(bar?.[0]?.kind).toBe('method');
    expect(bar?.[0]?.enclosingClass).toBe('Foo');
  });

  it('emits method with enclosingClass set for pointer receiver (*Foo → Foo)', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\ntype Foo struct{}\nfunc (f *Foo) baz() int { return 2 }\n`,
      'utf8',
    );
    const walk = run(dir);
    const baz = walk.occurrences.baz;
    expect(baz?.[0]?.kind).toBe('method');
    expect(baz?.[0]?.enclosingClass).toBe('Foo');
  });

  it('emits arrow occurrence for func_literal (closures)', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc maker() func(int) int {\n    inc := func(n int) int { return n + 1 }\n    return inc\n}\n`,
      'utf8',
    );
    const walk = run(dir);
    const arrowNames = Object.keys(walk.occurrences).filter((n) => n.startsWith('<arrow:'));
    expect(arrowNames.length).toBe(1);
    // Closure creation should produce a 'creation' call-site so
    // reachability flows from `maker` into the closure body.
    const creations = walk.callSites.filter((c) => c.kind === 'creation');
    expect(creations.length).toBeGreaterThan(0);
  });

  it('classifies visibility from leading-character case (Go convention)', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc Exported() {}\nfunc unexported() {}\n`,
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.Exported?.[0]?.visibility).toBe('exported');
    expect(walk.occurrences.unexported?.[0]?.visibility).toBe('module-local');
  });

  it('flags _test.go files as inTestFile', () => {
    writeFileSync(
      join(dir, 'thing_test.go'),
      `package main\nfunc TestSomething() {}\n`,
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.TestSomething?.[0]?.inTestFile).toBe(true);
  });

  it('preserves string and raw-string literals when stripping comments', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc withStrings() string {\n    _ = "a /* fake comment */ inside"\n    r := \`another // not a comment\`\n    _ = r\n    return "ok"\n}\n`,
      'utf8',
    );
    const walk = run(dir);
    expect(Object.keys(walk.occurrences)).toContain('withStrings');
  });

  it('handles block comments without nesting (Go does not nest)', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\n/* outer comment */\nfunc afterComment() int { return 1 }\n`,
      'utf8',
    );
    const walk = run(dir);
    expect(Object.keys(walk.occurrences)).toContain('afterComment');
  });

  it('records call_expression as call-site records', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/main.go'),
      `package main\nfunc caller() { callee() }\nfunc callee() {}\n`,
      'utf8',
    );
    const walk = run(dir);
    const calls = walk.callSites.filter((c) => c.kind === 'call');
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('preserves escape sequences inside interpreted string literals', () => {
    // `"\\\""` — an escaped quote. The interpreted-string scanner has
    // an escape branch (`\\` + next char).
    writeFileSync(
      join(dir, 'main.go'),
      String.raw`package main` + '\nfunc esc() string { return ' + String.raw`"a\"b"` + ' }\n',
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.esc).toBeDefined();
  });

  it('preserves rune literals — simple and escaped', () => {
    // `'a'` exercises the unescape path; `'\\n'` exercises the escape
    // branch in consumeRuneLiteral.
    writeFileSync(
      join(dir, 'main.go'),
      "package main\nfunc a() rune { return 'a' }\nfunc b() rune { return '\\n' }\n",
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.a).toBeDefined();
    expect(walk.occurrences.b).toBeDefined();
  });

  it('classifies *_generated.go files as definedInGenerated', () => {
    writeFileSync(
      join(dir, 'foo_generated.go'),
      `package main\nfunc Gen() {}\n`,
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.Gen?.[0]?.definedInGenerated).toBe(true);
  });

  it('classifies *.gen.go files as definedInGenerated', () => {
    writeFileSync(
      join(dir, 'queries.gen.go'),
      `package main\nfunc GenQ() {}\n`,
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.GenQ?.[0]?.definedInGenerated).toBe(true);
  });

  it('classifies .pb.go files as definedInGenerated', () => {
    writeFileSync(
      join(dir, 'proto.pb.go'),
      `package main\nfunc ProtoFunc() {}\n`,
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.ProtoFunc?.[0]?.definedInGenerated).toBe(true);
  });

  it('emits a synthetic <module-init> per file', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nimport "fmt"\nvar greeting = "hi"\nfunc m() { fmt.Println(greeting) }\n`,
      'utf8',
    );
    const walk = run(dir);
    const moduleInits = Object.keys(walk.occurrences).filter((n) => n.startsWith('<module-init:'));
    expect(moduleInits.length).toBe(1);
    const occ = walk.occurrences[moduleInits[0]]?.[0];
    expect(occ?.kind).toBe('module-init');
    expect(occ?.visibility).toBe('module-local');
  });

  it('emits multi-name parameter declaration (`func f(a, b int)`)', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc add(a, b int) int { return a + b }\n`,
      'utf8',
    );
    const walk = run(dir);
    const params = walk.occurrences.add?.[0]?.params;
    expect(params?.map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('emits variadic parameter as rest=true', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc sum(xs ...int) int { return 0 }\n`,
      'utf8',
    );
    const walk = run(dir);
    const params = walk.occurrences.sum?.[0]?.params;
    expect(params?.[0]?.rest).toBe(true);
  });

  it('strips // line comments and /* */ block comments inside function bodies', () => {
    // Body contains both `//` line and `/* */` block comments to
    // exercise stripGoComments' line+block branches during body
    // normalization.
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc withComments() int {\n    // explanation\n    /* block */\n    return 1\n}\n`,
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.withComments).toBeDefined();
  });

  it('handles generic receiver types (Foo[T])', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main\ntype Box[T any] struct { v T }\nfunc (b Box[T]) Get() T { return b.v }\n`,
      'utf8',
    );
    const walk = run(dir);
    const get = walk.occurrences.Get?.[0];
    expect(get?.kind).toBe('method');
    expect(get?.enclosingClass).toBe('Box');
  });
});
