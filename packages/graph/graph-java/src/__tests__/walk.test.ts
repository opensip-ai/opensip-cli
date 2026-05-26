/**
 * Branch-coverage tests for graph-java/walk.ts.
 *
 * Drives the full Java adapter (discover + parse + walk) over fixtures
 * exercising: class/interface/record/enum context, method/constructor
 * declarations, lambda emission, modifier-based visibility,
 * annotations including @Test, and body normalization (line, block,
 * Javadoc comments, regular strings, text blocks, char literals).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { javaGraphAdapter } from '../index.js';

function run(dir: string): ReturnType<typeof javaGraphAdapter.walkProject> {
  const discovery = javaGraphAdapter.discoverFiles({ cwd: dir });
  const parsed = javaGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
  });
  return javaGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
}

describe('graph-java walk.ts', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-java-walk-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits method with enclosingClass set to the immediate class name', () => {
    writeFileSync(
      join(dir, 'A.java'),
      'package x;\nclass A { int doSomething() { return 1; } }\n',
      'utf8',
    );
    const walk = run(dir);
    const m = walk.occurrences.doSomething;
    expect(m?.[0]?.kind).toBe('method');
    expect(m?.[0]?.enclosingClass).toBe('A');
  });

  it('emits constructor with kind=constructor and enclosingClass set', () => {
    writeFileSync(
      join(dir, 'Foo.java'),
      'package x;\nclass Foo { Foo(int n) { } }\n',
      'utf8',
    );
    const walk = run(dir);
    const ctor = walk.occurrences.Foo;
    // The constructor is named the same as the class; it lives under
    // simpleName="Foo".
    expect(ctor?.some((o) => o.kind === 'constructor')).toBe(true);
  });

  it('tracks enclosingClass through interface_declaration', () => {
    writeFileSync(
      join(dir, 'I.java'),
      'package x;\ninterface I { default int m() { return 7; } }\n',
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.m?.[0]?.enclosingClass).toBe('I');
  });

  it('tracks enclosingClass through record_declaration', () => {
    writeFileSync(
      join(dir, 'Rec.java'),
      'package x;\nrecord Rec(int n) { public int doubled() { return n * 2; } }\n',
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.doubled?.[0]?.enclosingClass).toBe('Rec');
  });

  it('tracks enclosingClass through enum_declaration', () => {
    writeFileSync(
      join(dir, 'E.java'),
      'package x;\nenum E { ONE, TWO; public int code() { return 1; } }\n',
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.code?.[0]?.enclosingClass).toBe('E');
  });

  it('emits arrow occurrence for lambda_expression with creation edge', () => {
    writeFileSync(
      join(dir, 'L.java'),
      `package x;\nimport java.util.function.IntUnaryOperator;\nclass L { static IntUnaryOperator make() { IntUnaryOperator inc = n -> n + 1; return inc; } }\n`,
      'utf8',
    );
    const walk = run(dir);
    const arrows = Object.keys(walk.occurrences).filter((n) => n.startsWith('<arrow:'));
    expect(arrows.length).toBe(1);
    const creations = walk.callSites.filter((c) => c.kind === 'creation');
    expect(creations.length).toBeGreaterThan(0);
  });

  it('classifies public/protected as exported, private as module-local', () => {
    writeFileSync(
      join(dir, 'V.java'),
      `package x;\nclass V {\n  public void pub() {}\n  protected void prot() {}\n  private void priv() {}\n  void pkg() {}\n}\n`,
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.pub?.[0]?.visibility).toBe('exported');
    expect(walk.occurrences.prot?.[0]?.visibility).toBe('exported');
    expect(walk.occurrences.priv?.[0]?.visibility).toBe('module-local');
    expect(walk.occurrences.pkg?.[0]?.visibility).toBe('module-local');
  });

  it('flags /test/ path files as inTestFile', () => {
    mkdirSync(join(dir, 'src/test/java'), { recursive: true });
    writeFileSync(
      join(dir, 'src/test/java/Sample.java'),
      'package x;\nclass Sample { void method() {} }\n',
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.method?.[0]?.inTestFile).toBe(true);
  });

  it('flags *Test.java filenames as inTestFile', () => {
    writeFileSync(
      join(dir, 'ThingTest.java'),
      'package x;\nclass ThingTest { void m() {} }\n',
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.m?.[0]?.inTestFile).toBe(true);
  });

  it('flags @Test-annotated methods as inTestFile even outside test paths', () => {
    writeFileSync(
      join(dir, 'Inline.java'),
      `package x;\nclass Inline {\n  @Test\n  public void annotatedTest() {}\n}\n`,
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.annotatedTest?.[0]?.inTestFile).toBe(true);
  });

  it('preserves regular and text-block string literals when stripping comments', () => {
    writeFileSync(
      join(dir, 'S.java'),
      `package x;\nclass S {\n  String m() {\n    String a = "a /* fake comment */ inside";\n    String b = """\n      another // not a comment\n      """;\n    return a + b;\n  }\n}\n`,
      'utf8',
    );
    const walk = run(dir);
    expect(walk.occurrences.m).toBeDefined();
  });

  it('records method_invocation as a call-site', () => {
    writeFileSync(
      join(dir, 'C.java'),
      `package x;\nclass C { void caller() { callee(); } void callee() {} }\n`,
      'utf8',
    );
    const walk = run(dir);
    const calls = walk.callSites.filter((c) => c.kind === 'call');
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('records object_creation_expression (new Foo()) as a call-site', () => {
    writeFileSync(
      join(dir, 'N.java'),
      `package x;\nclass N { void main() { Foo f = new Foo(); } }\nclass Foo { Foo() {} }\n`,
      'utf8',
    );
    const walk = run(dir);
    const calls = walk.callSites.filter((c) => c.kind === 'call');
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('records explicit_constructor_invocation (super/this calls)', () => {
    writeFileSync(
      join(dir, 'Sub.java'),
      `package x;\nclass Base { Base(int n) {} }\nclass Sub extends Base {\n  Sub() { super(1); }\n  Sub(int n) { this(); }\n}\n`,
      'utf8',
    );
    const walk = run(dir);
    const calls = walk.callSites.filter((c) => c.kind === 'call');
    // Two explicit_constructor_invocation nodes (super(1) and this()).
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
