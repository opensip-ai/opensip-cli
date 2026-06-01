/**
 * Branch-coverage tests for lang-rust/resolve-dependencies.ts.
 *
 * Targets the module-path resolution edge cases that the main
 * depends-on-emission suite doesn't reach:
 *
 *   - importer files OUTSIDE `src/` (tests/, examples/) whose module
 *     path is `null` — `self::` / `super::` rewriting becomes impossible.
 *   - module-init occurrences whose filePath isn't a recognizable crate
 *     module (skipped during index build).
 *   - Cargo.toml manifests with comment lines, blank lines, and a stray
 *     `name = …` that appears OUTSIDE the `[package]` table.
 *   - `super::` from the crate root (`src/lib.rs`) — walk-up clamps at
 *     `crate`.
 *   - `src/mod.rs` and bare `src/<name>/mod.rs` module-path mapping.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rustGraphAdapter } from '../index.js';

import type { Catalog, DependencyEdge, FunctionOccurrence } from '@opensip-tools/graph';

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'graph-rust-depbranch-'));
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
  dependenciesByOwner: ReadonlyMap<string, readonly DependencyEdge[]> | undefined;
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
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'rust',
    builtAt: new Date().toISOString(),
    cacheKey: 'test',
    functions: walked.occurrences,
  };
  const resolved = rustGraphAdapter.resolveCallSites({
    project: parsed.project,
    catalog,
    callSites: walked.callSites,
    dependencySites: walked.dependencySites,
    projectDirAbs: discovery.projectDirAbs,
    resolutionMode: 'exact',
  });
  return { catalog, dependenciesByOwner: resolved.dependenciesByOwner };
}

const CARGO_TOML = `[package]\nname = "myproj"\nversion = "0.1.0"\nedition = "2021"\n`;

describe('Rust depends-on — importer module path is null (file outside src/)', () => {
  it('leaves `self::x` unresolved when imported from a tests/ file (no module path)', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile('src/lib.rs', `pub fn run() {}\n`);
    // tests/ files are separate compilation units → module path null.
    writeFile('tests/it.rs', `use self::helper::Thing;\n\nfn _u(_: Thing) {}\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const testInit = findModuleInit(catalog, 'tests/it.rs');
    expect(testInit).toBeDefined();

    const deps = dependenciesByOwner!.get(testInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('self::helper::Thing');
    // importerModulePath is null → `self::` cannot anchor → unresolved.
    expect(deps![0].to).toEqual([]);
  });

  it('leaves `super::x` unresolved when imported from a tests/ file (no module path)', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile('src/lib.rs', `pub fn run() {}\n`);
    writeFile('tests/it.rs', `use super::sibling::Thing;\n\nfn _u(_: Thing) {}\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const testInit = findModuleInit(catalog, 'tests/it.rs');
    expect(testInit).toBeDefined();

    const deps = dependenciesByOwner!.get(testInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('super::sibling::Thing');
    expect(deps![0].to).toEqual([]);
  });
});

describe('Rust depends-on — `super::` from the crate root clamps at `crate`', () => {
  it('walks up no further than `crate` when `super::` is used in src/lib.rs', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    // `super` from the crate root has nowhere to go; the walk-up clamps
    // to `crate`, so `super::foo` resolves as `crate::foo`.
    writeFile('src/lib.rs', `pub mod foo;\n\nuse super::foo::Bar;\n\nfn _u(_: Bar) {}\n`);
    writeFile('src/foo.rs', `pub struct Bar;\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    const fooInit = findModuleInit(catalog, 'src/foo.rs');
    expect(libInit).toBeDefined();
    expect(fooInit).toBeDefined();

    const deps = dependenciesByOwner!.get(libInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('super::foo::Bar');
    expect(deps![0].to).toEqual([fooInit!.bodyHash]);
  });
});

describe('Rust depends-on — Cargo.toml parsing edge cases', () => {
  it('ignores comment lines, blank lines, and a `name` outside [package]', () => {
    // The leading `name = "decoy"` sits OUTSIDE any `[package]` table
    // and must be ignored; the real name comes from inside [package].
    writeFile(
      'Cargo.toml',
      `# a comment\n` +
        `name = "decoy"\n` +
        `\n` +
        `[dependencies]\n` +
        `serde = "1"\n` +
        `\n` +
        `[package]\n` +
        `# inner comment\n` +
        `name = "realname"\n` +
        `version = "0.1.0"\n`,
    );
    writeFile('src/lib.rs', `pub mod foo;\n\nuse realname::foo::Bar;\n\nfn _u(_: Bar) {}\n`);
    writeFile('src/foo.rs', `pub struct Bar;\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    const fooInit = findModuleInit(catalog, 'src/foo.rs');
    expect(libInit).toBeDefined();
    expect(fooInit).toBeDefined();

    const deps = dependenciesByOwner!.get(libInit!.bodyHash);
    expect(deps).toHaveLength(1);
    // `realname::foo::Bar` resolves because the package name parsed from
    // INSIDE [package] is `realname` (the decoy outside is ignored).
    expect(deps![0].to).toEqual([fooInit!.bodyHash]);
  });

  it('returns no package-name match when [package] has no name (decoy outside only)', () => {
    writeFile(
      'Cargo.toml',
      `name = "decoy"\n[package]\nversion = "0.1.0"\n`,
    );
    writeFile('src/lib.rs', `pub mod foo;\n\nuse decoy::foo::Bar;\n\nfn _u(_: Bar) {}\n`);
    writeFile('src/foo.rs', `pub struct Bar;\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    expect(libInit).toBeDefined();

    const deps = dependenciesByOwner!.get(libInit!.bodyHash);
    expect(deps).toHaveLength(1);
    // package name never resolved (decoy is outside [package]); the
    // `decoy::` alias therefore cannot anchor → unresolved.
    expect(deps![0].to).toEqual([]);
  });
});

describe('Rust depends-on — module-path mapping via mod.rs layout', () => {
  it('maps a top-level `src/mod.rs` to `crate` (segments empty after popping `mod`)', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    // `src/mod.rs` is an unusual layout: filePathToRustModulePath strips
    // the trailing `mod` segment leaving an empty list → `crate`. The
    // importer here references `crate::run`, which walks back to the
    // `src/mod.rs` module-init (mapped to `crate`).
    writeFile('src/mod.rs', `pub fn run() {}\n\nuse crate::run;\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const modInit = findModuleInit(catalog, 'src/mod.rs');
    expect(modInit).toBeDefined();

    const deps = dependenciesByOwner!.get(modInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('crate::run');
    // `crate::run` → `run` is an item, resolution walks back to `crate`,
    // which maps to the `src/mod.rs` module-init itself.
    expect(deps![0].to).toEqual([modInit!.bodyHash]);
  });

  it('maps `src/<dir>/mod.rs` to `crate::<dir>` and resolves an import to it', () => {
    writeFile('Cargo.toml', CARGO_TOML);
    writeFile('src/lib.rs', `pub mod widgets;\n\nuse crate::widgets::Gizmo;\n\nfn _u(_: Gizmo) {}\n`);
    writeFile('src/widgets/mod.rs', `pub struct Gizmo;\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const libInit = findModuleInit(catalog, 'src/lib.rs');
    const widgetsInit = findModuleInit(catalog, 'src/widgets/mod.rs');
    expect(libInit).toBeDefined();
    expect(widgetsInit).toBeDefined();

    const deps = dependenciesByOwner!.get(libInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].to).toEqual([widgetsInit!.bodyHash]);
  });
});
