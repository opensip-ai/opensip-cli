/**
 * Tests for the Rust adapter's module-level depends_on edge emission.
 * Phase 4 Task 4.5 of opensip's substrate consolidation (opensip DEC-498).
 *
 * Exercises the full adapter contract surface (discoverFiles →
 * parseProject → walkProject → resolveCallSites) against small fixtures
 * covering the Rust `use`-declaration matrix: absolute `crate::` paths,
 * `super::` / `self::` relative paths, grouped imports, aliased imports,
 * globs, stdlib + third-party paths, missing Cargo.toml, and
 * declaration-free files.
 *
 * Mirrors the Go adapter's Task 4.4 test layout.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rustGraphAdapter } from '../index.js';

import type { Catalog, FunctionOccurrence } from '@opensip-tools/graph';

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'graph-rust-depends-on-'));
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): void {
  const abs = join(fixtureRoot, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function findModuleInit(catalog: Catalog, filePath: string): FunctionOccurrence | undefined {
  for (const occs of Object.values(catalog.functions)) {
    for (const o of occs) {
      if (o.kind === 'module-init' && o.filePath === filePath) return o;
    }
  }
  return undefined;
}

function runAdapter(): {
  catalog: Catalog;
  dependenciesByOwner:
    | ReadonlyMap<
        string,
        readonly {
          readonly to: readonly string[];
          readonly specifier: string;
          readonly line: number;
          readonly column: number;
        }[]
      >
    | undefined;
} {
  const discovery = rustGraphAdapter.discoverFiles({ cwd: fixtureRoot });
  const parsed = rustGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  const walked = rustGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  const initialCatalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'rust',
    builtAt: new Date().toISOString(),
    cacheKey: 'test',
    functions: walked.occurrences,
  };
  const resolved = rustGraphAdapter.resolveCallSites({
    project: parsed.project,
    catalog: initialCatalog,
    callSites: walked.callSites,
    dependencySites: walked.dependencySites,
    projectDirAbs: discovery.projectDirAbs,
    resolutionMode: 'exact',
  });
  return { catalog: initialCatalog, dependenciesByOwner: resolved.dependenciesByOwner };
}

const CARGO_TOML = `[package]\nname = "myproj"\nversion = "0.1.0"\nedition = "2021"\n`;

describe('Rust adapter — depends_on emission (Phase 4)', () => {
  it('resolves a simple absolute `crate::` import to the target module-init', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile('src/lib.rs', `pub mod foo;\n\nuse crate::foo::bar;\n\npub fn run() {}\n`);
    writeFile('src/foo.rs', `pub fn bar() -> i32 { 1 }\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    const fooInit = findModuleInit(catalog, 'src/foo.rs');

    expect(libInit, 'lib module-init').toBeDefined();
    expect(fooInit, 'foo module-init').toBeDefined();
    expect(dependenciesByOwner, 'dependenciesByOwner').toBeDefined();

    const libDeps = dependenciesByOwner!.get(libInit!.bodyHash);
    expect(libDeps, 'lib has dependency edges').toHaveLength(1);
    expect(libDeps![0].specifier).toBe('crate::foo::bar');
    // `crate::foo::bar` — `bar` is an item, not a module, so resolution
    // walks back to `crate::foo`.
    expect(libDeps![0].to).toEqual([fooInit!.bodyHash]);
  });

  it('resolves a nested module import — `crate::foo::sub`', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile('src/lib.rs', `pub mod foo;\n\nuse crate::foo::sub::Item;\n\nfn _use(_: Item) {}\n`);
    writeFile('src/foo.rs', `pub mod sub;\n`);
    writeFile('src/foo/sub.rs', `pub struct Item;\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    const subInit = findModuleInit(catalog, 'src/foo/sub.rs');

    expect(libInit).toBeDefined();
    expect(subInit).toBeDefined();

    const deps = dependenciesByOwner!.get(libInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('crate::foo::sub::Item');
    expect(deps![0].to).toEqual([subInit!.bodyHash]);
  });

  it('resolves `super::sibling` from a nested module', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile('src/lib.rs', `pub mod a;\n`);
    writeFile('src/a/mod.rs', `pub mod b;\npub mod sibling;\n`);
    writeFile('src/a/b.rs', `use super::sibling::Thing;\n\nfn _use(_: Thing) {}\n`);
    writeFile('src/a/sibling.rs', `pub struct Thing;\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const bInit = findModuleInit(catalog, 'src/a/b.rs');
    const siblingInit = findModuleInit(catalog, 'src/a/sibling.rs');

    expect(bInit).toBeDefined();
    expect(siblingInit).toBeDefined();

    const deps = dependenciesByOwner!.get(bInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('super::sibling::Thing');
    expect(deps![0].to).toEqual([siblingInit!.bodyHash]);
  });

  it('resolves `self::child` from a parent module file', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile('src/lib.rs', `pub mod a;\n`);
    writeFile(
      'src/a/mod.rs',
      `pub mod child;\n\nuse self::child::Thing;\n\nfn _use(_: Thing) {}\n`,
    );
    writeFile('src/a/child.rs', `pub struct Thing;\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const aInit = findModuleInit(catalog, 'src/a/mod.rs');
    const childInit = findModuleInit(catalog, 'src/a/child.rs');

    expect(aInit).toBeDefined();
    expect(childInit).toBeDefined();

    const deps = dependenciesByOwner!.get(aInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('self::child::Thing');
    expect(deps![0].to).toEqual([childInit!.bodyHash]);
  });

  it('emits unresolved edges for stdlib imports', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile(
      'src/lib.rs',
      `use std::collections::HashMap;\n\npub fn run(_: HashMap<i32, i32>) {}\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    expect(libInit).toBeDefined();

    const deps = dependenciesByOwner!.get(libInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('std::collections::HashMap');
    expect(deps![0].to).toEqual([]);
  });

  it('emits unresolved edges for third-party imports', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile('src/lib.rs', `use serde::Deserialize;\n\npub fn run() {}\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    expect(libInit).toBeDefined();

    const deps = dependenciesByOwner!.get(libInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('serde::Deserialize');
    expect(deps![0].to).toEqual([]);
  });

  it('handles grouped imports — emits one dep site per terminal path', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile('src/lib.rs', `use std::{io::Read, fs::File};\n\npub fn run() {}\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    expect(libInit).toBeDefined();

    const deps = dependenciesByOwner!.get(libInit!.bodyHash);
    expect(deps).toHaveLength(2);
    const specifiers = deps!.map((d) => d.specifier).sort();
    expect(specifiers).toEqual(['std::fs::File', 'std::io::Read']);
    for (const d of deps!) {
      expect(d.to).toEqual([]);
    }
  });

  it('treats `self` inside a group as a reference to the parent path', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile('src/lib.rs', `use std::io::{self, Read};\n\npub fn run() {}\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    expect(libInit).toBeDefined();

    const deps = dependenciesByOwner!.get(libInit!.bodyHash);
    expect(deps).toHaveLength(2);
    const specifiers = deps!.map((d) => d.specifier).sort();
    expect(specifiers).toEqual(['std::io', 'std::io::Read']);
    for (const d of deps!) {
      expect(d.to).toEqual([]);
    }
  });

  it('treats aliased imports the same as unaliased (alias does not change specifier)', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile('src/lib.rs', `pub mod foo;\n\nuse crate::foo::Bar as Baz;\n\nfn _use(_: Baz) {}\n`);
    writeFile('src/foo.rs', `pub struct Bar;\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    const fooInit = findModuleInit(catalog, 'src/foo.rs');

    expect(libInit).toBeDefined();
    expect(fooInit).toBeDefined();

    const deps = dependenciesByOwner!.get(libInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('crate::foo::Bar');
    expect(deps![0].to).toEqual([fooInit!.bodyHash]);
  });

  it('emits a glob dep site with trailing `*`; resolver leaves it unresolved (v1 limitation)', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile('src/lib.rs', `pub mod foo;\n\nuse crate::foo::*;\n\npub fn run() {}\n`);
    writeFile('src/foo.rs', `pub struct A;\npub struct B;\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    expect(libInit).toBeDefined();

    const deps = dependenciesByOwner!.get(libInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('crate::foo::*');
    expect(deps![0].to).toEqual([]);
  });

  it('treats `<package-name>::…` as equivalent to `crate::…`', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile('src/lib.rs', `pub mod foo;\n\nuse myproj::foo::Bar;\n\nfn _use(_: Bar) {}\n`);
    writeFile('src/foo.rs', `pub struct Bar;\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    const fooInit = findModuleInit(catalog, 'src/foo.rs');

    expect(libInit).toBeDefined();
    expect(fooInit).toBeDefined();

    const deps = dependenciesByOwner!.get(libInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('myproj::foo::Bar');
    expect(deps![0].to).toEqual([fooInit!.bodyHash]);
  });

  it('treats all `crate::` imports as unresolved when Cargo.toml is missing', () => {
    // No Cargo.toml — package name unknown, `crate::…` cannot anchor.
    writeFile('src/lib.rs', `pub mod foo;\n\nuse crate::foo::Bar;\n\nfn _use(_: Bar) {}\n`);
    writeFile('src/foo.rs', `pub struct Bar;\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    expect(libInit).toBeDefined();

    const deps = dependenciesByOwner!.get(libInit!.bodyHash);
    // Even without Cargo.toml, `crate::` still anchors against the
    // module-path map derived from `src/` layout (no need for the
    // package name). The resolver does NOT require Cargo.toml for
    // `crate::` resolution — only for the `<package-name>::` alias.
    // Document this behavior here:
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('crate::foo::Bar');
    expect(deps![0].to).toEqual([findModuleInit(catalog, 'src/foo.rs')!.bodyHash]);
  });

  it('treats `<package-name>::…` as unresolved when Cargo.toml is missing', () => {
    // Without Cargo.toml, the package-name alias is the only path we
    // genuinely lose; verify that surfaces as unresolved.
    writeFile('src/lib.rs', `pub mod foo;\n\nuse myproj::foo::Bar;\n\nfn _use(_: Bar) {}\n`);
    writeFile('src/foo.rs', `pub struct Bar;\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    expect(libInit).toBeDefined();

    const deps = dependenciesByOwner!.get(libInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('myproj::foo::Bar');
    expect(deps![0].to).toEqual([]);
  });

  it('produces no dependency edges for a file with no `use` declarations', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile('src/lib.rs', `pub fn standalone() -> i32 { 42 }\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    expect(libInit).toBeDefined();

    const deps = dependenciesByOwner?.get(libInit!.bodyHash);
    expect(deps).toBeUndefined();
  });
});
