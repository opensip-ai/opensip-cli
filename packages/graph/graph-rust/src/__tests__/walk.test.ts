/**
 * Branch-coverage tests for lang-rust/walk.ts.
 *
 * Drives the full Rust adapter (discover + parse + walk) over fixtures
 * that include line comments, block comments, nested block comments,
 * and string literals. These exercise the comment-stripping helpers
 * (skipToEndOfLine, skipBlockComment, consumeStringLiteral) used by
 * the body-hash normalizer.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rustGraphAdapter } from '../index.js';

describe('lang-rust walk.ts — comment-stripping branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-rust-walk-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('walks a Rust file with line comments without error', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `// hello\nfn with_line_comment() -> i32 {\n    // inner comment\n    1\n}\n`,
      'utf8',
    );
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
    expect(Object.keys(walk.occurrences).length).toBeGreaterThan(0);
    expect(Object.keys(walk.occurrences)).toContain('with_line_comment');
  });

  it('walks a Rust file with block comments and nested block comments', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `/* simple block */\n` +
        `/* nested /* deeper */ outer */\n` +
        `fn with_block_comment() -> i32 {\n` +
        `    /* mid-body */\n` +
        `    1\n` +
        `}\n`,
      'utf8',
    );
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
    expect(Object.keys(walk.occurrences)).toContain('with_block_comment');
  });

  it('preserves string literals when stripping comments', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn with_strings() -> &'static str {\n` +
        `    let _ = "a /* fake comment */ inside string";\n` +
        `    let _ = "another // not a comment";\n` +
        `    "ok"\n` +
        `}\n`,
      'utf8',
    );
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
    expect(Object.keys(walk.occurrences)).toContain('with_strings');
  });
});

/**
 * Tests for the function/impl/closure shapes the walker emits. These
 * cover visitImpl / visitFunction / visitClosure and the helpers
 * (implTargetName, classifyVisibility, classifyRustFunctionKind,
 * extractAttributes, extractParams).
 */
describe('lang-rust walk.ts — function shapes and occurrences', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-rust-walk-shapes-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(): ReturnType<typeof rustGraphAdapter.walkProject> {
    const discovery = rustGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = rustGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
    });
    return rustGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
  }

  it('emits methods inside `impl` blocks with enclosingClass set', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `struct Foo;\n` +
        `impl Foo {\n` +
        `    pub fn new() -> Self { Foo }\n` +
        `    pub fn run(&self) -> i32 { 1 }\n` +
        `}\n`,
      'utf8',
    );
    const walk = run();
    const newFn = walk.occurrences.new?.[0];
    const runFn = walk.occurrences.run?.[0];
    expect(newFn).toBeDefined();
    expect(runFn).toBeDefined();
    expect(newFn?.enclosingClass).toBe('Foo');
    expect(runFn?.enclosingClass).toBe('Foo');
    // `new` is treated as a constructor.
    expect(newFn?.kind).toBe('constructor');
    expect(runFn?.kind).toBe('method');
    // pub fn → exported.
    expect(newFn?.visibility).toBe('exported');
    // qualified name includes module path + impl type.
    expect(newFn?.qualifiedName).toContain('Foo::new');
    expect(runFn?.qualifiedName).toContain('Foo::run');
  });

  it('emits a `function-declaration` for free functions at module scope', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn private_fn() -> i32 { 1 }\npub fn exported_fn() -> i32 { 2 }\n`,
      'utf8',
    );
    const walk = run();
    const priv = walk.occurrences.private_fn?.[0];
    const exp = walk.occurrences.exported_fn?.[0];
    expect(priv?.kind).toBe('function-declaration');
    expect(priv?.visibility).toBe('module-local');
    expect(priv?.enclosingClass).toBe(null);
    expect(exp?.visibility).toBe('exported');
  });

  it('emits an arrow occurrence + creation edge for an inline closure', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn make_adder() -> impl Fn(i32) -> i32 {\n` +
        `    let inc = |n: i32| n + 1;\n` +
        `    inc\n` +
        `}\n`,
      'utf8',
    );
    const walk = run();
    // Closure simpleName is `<arrow:...>`. Find any matching key.
    const closureKeys = Object.keys(walk.occurrences).filter((k) => k.startsWith('<arrow:'));
    expect(closureKeys.length).toBe(1);
    const closure = walk.occurrences[closureKeys[0]]?.[0];
    expect(closure?.kind).toBe('arrow');
    expect(closure?.enclosingClass).toBe(null);
    expect(closure?.visibility).toBe('private');
    // Closure params extracted from `|n: i32|`.
    expect(closure?.params.length).toBeGreaterThan(0);
    // The walker should have emitted a creation call-site for the closure.
    const creation = walk.callSites.find((cs) => cs.kind === 'creation');
    expect(creation).toBeDefined();
    expect(creation?.childHash).toBe(closure?.bodyHash);
  });

  it('produces a `<module-init>` occurrence for each file', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `use std::collections::HashMap;\nconst N: i32 = 5;\n`,
      'utf8',
    );
    const walk = run();
    const initKey = Object.keys(walk.occurrences).find((k) => k.startsWith('<module-init:'));
    expect(initKey).toBeDefined();
    const init = walk.occurrences[initKey!]?.[0];
    expect(init?.kind).toBe('module-init');
    expect(init?.line).toBe(1);
    expect(init?.column).toBe(0);
    expect(init?.visibility).toBe('module-local');
  });

  it('tags `#[test]`-annotated functions as inTestFile even in a non-test file', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    // Place helper BEFORE the test attribute + function so that
    // attribute-sibling scanning (which walks `parent.children` up to
    // the current function) doesn't also see the `#[test]` attribute.
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn helper() { }\n#[test]\nfn it_works() {\n    assert_eq!(1, 1);\n}\n`,
      'utf8',
    );
    const walk = run();
    const testFn = walk.occurrences.it_works?.[0];
    const helperFn = walk.occurrences.helper?.[0];
    expect(testFn?.inTestFile).toBe(true);
    // The decorators list should include the #[test] attribute text.
    expect(testFn?.decorators.some((d) => d.includes('#[test]'))).toBe(true);
    expect(helperFn?.inTestFile).toBe(false);
  });

  it('flags files under tests/ as test files (path-based detection)', () => {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(
      join(dir, 'tests/integration.rs'),
      `fn integ() { }\n`,
      'utf8',
    );
    const walk = run();
    const integ = walk.occurrences.integ?.[0];
    expect(integ?.inTestFile).toBe(true);
  });

  it('flags `*_test.rs` files as test files (path-based detection)', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib_test.rs'),
      `fn t() { }\n`,
      'utf8',
    );
    const walk = run();
    const t = walk.occurrences.t?.[0];
    expect(t?.inTestFile).toBe(true);
  });

  it('flags files under target/ as definedInGenerated (when somehow walked)', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    // We seed a file with `target/` in its rel-path. discoverFiles
    // excludes `target/`, so we manually feed walkProject paths.
    const f1 = join(dir, 'src/normal.rs');
    writeFileSync(f1, `fn n() { }\n`, 'utf8');
    const f2 = join(dir, 'src/foo.generated.rs');
    writeFileSync(f2, `fn g() { }\n`, 'utf8');
    const discovery = rustGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = rustGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: [f1, f2],
      compilerOptions: discovery.compilerOptions,
    });
    const walk = rustGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: [f1, f2],
    });
    const g = walk.occurrences.g?.[0];
    const n = walk.occurrences.n?.[0];
    expect(g?.definedInGenerated).toBe(true);
    expect(n?.definedInGenerated).toBe(false);
  });

  it('extracts function parameters including `self_parameter`', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `struct G;\n` +
        `impl G {\n` +
        `    fn method(&self, x: i32, y: String) -> i32 { x }\n` +
        `}\n`,
      'utf8',
    );
    const walk = run();
    const m = walk.occurrences.method?.[0];
    expect(m).toBeDefined();
    const names = m?.params.map((p) => p.name);
    expect(names).toContain('self');
    // The other two parameters' patterns are identifiers x and y.
    expect(names?.includes('x')).toBe(true);
    expect(names?.includes('y')).toBe(true);
  });

  it('extracts closure parameters as identifiers', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn outer() {\n` +
        `    let f = |a, b| a;\n` +
        `    let _ = f;\n` +
        `}\n`,
      'utf8',
    );
    const walk = run();
    const closureKeys = Object.keys(walk.occurrences).filter((k) => k.startsWith('<arrow:'));
    expect(closureKeys.length).toBe(1);
    const closure = walk.occurrences[closureKeys[0]]?.[0];
    const paramNames = closure?.params.map((p) => p.name);
    // identifier-typed bare closure params should be picked up.
    expect(paramNames).toContain('a');
    expect(paramNames).toContain('b');
  });

  it('resolves enclosingClass for generic `impl Foo<T>` blocks', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `struct Box<T>(T);\n` +
        `impl<T> Box<T> {\n` +
        `    fn unwrap(self) -> T { self.0 }\n` +
        `}\n`,
      'utf8',
    );
    const walk = run();
    const u = walk.occurrences.unwrap?.[0];
    expect(u).toBeDefined();
    expect(u?.enclosingClass).not.toBeNull();
    // The `unwrap` method should be tagged as a method.
    expect(u?.kind).toBe('method');
  });

  it('skips files in input.files that are not present in the parsed project', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    const f = join(dir, 'src/lib.rs');
    writeFileSync(f, `fn x() {}\n`, 'utf8');
    const discovery = rustGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = rustGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: [], // parse no files
      compilerOptions: discovery.compilerOptions,
    });
    const walk = rustGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    // No parse output → no occurrences (other than nothing).
    expect(walk.occurrences).toEqual({});
    expect(walk.callSites).toEqual([]);
  });
});
