/**
 * Additional branch-coverage tests for lang-rust/walk.ts.
 *
 * Targets walker branches the main walk suite doesn't reach:
 *
 *   - `extern crate foo;` declarations → dependency sites.
 *   - `pub use …;` — the visibility_modifier is skipped while picking
 *     the path-bearing child (pickUsePathNode reverse-walk).
 *   - `#[...]` inner/outer attribute extraction on a function_item.
 *   - trait-method declarations inside a `trait` block.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rustGraphAdapter } from '../index.js';

import type { Catalog, DependencyEdge, FunctionOccurrence } from '@opensip-tools/graph';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-rust-walkbranch-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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
  walk: ReturnType<typeof rustGraphAdapter.walkProject>;
  dependenciesByOwner: ReadonlyMap<string, readonly DependencyEdge[]> | undefined;
} {
  const discovery = rustGraphAdapter.discoverFiles({ cwd: dir });
  const parsed = rustGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
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
    cacheKey: 'test',
    functions: walk.occurrences,
  };
  const resolved = rustGraphAdapter.resolveCallSites({
    project: parsed.project,
    catalog,
    callSites: walk.callSites,
    dependencySites: walk.dependencySites,
    projectDirAbs: discovery.projectDirAbs,
    resolutionMode: 'exact',
  });
  return { catalog, walk, dependenciesByOwner: resolved.dependenciesByOwner };
}

describe('lang-rust walk.ts — extern crate + pub use branches', () => {
  it('emits a dependency site for `extern crate foo;`', () => {
    writeFileSync(join(dir, 'lib.rs'), `extern crate serde;\n\npub fn run() {}\n`, 'utf8');
    const { catalog, dependenciesByOwner } = runAdapter();
    const init = findModuleInit(catalog, 'lib.rs');
    expect(init).toBeDefined();
    const deps = dependenciesByOwner!.get(init!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('serde');
    // External crate → unresolved.
    expect(deps![0].to).toEqual([]);
  });

  it('emits a dependency site for `extern crate foo as bar;` using the crate name', () => {
    writeFileSync(join(dir, 'lib.rs'), `extern crate serde as s;\n\npub fn run() {}\n`, 'utf8');
    const { catalog, dependenciesByOwner } = runAdapter();
    const init = findModuleInit(catalog, 'lib.rs');
    expect(init).toBeDefined();
    const deps = dependenciesByOwner!.get(init!.bodyHash);
    expect(deps).toHaveLength(1);
    // The crate name (first identifier), not the alias, is the specifier.
    expect(deps![0].specifier).toBe('serde');
  });

  it('skips the visibility_modifier when picking the use path for `pub use …;`', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `pub use std::collections::HashMap;\n\npub fn run() {}\n`,
      'utf8',
    );
    const { catalog, dependenciesByOwner } = runAdapter();
    const init = findModuleInit(catalog, 'src/lib.rs');
    expect(init).toBeDefined();
    const deps = dependenciesByOwner!.get(init!.bodyHash);
    expect(deps).toHaveLength(1);
    // The visibility_modifier (`pub`) must be skipped — the specifier is
    // the underlying path only.
    expect(deps![0].specifier).toBe('std::collections::HashMap');
  });
});

describe('lang-rust walk.ts — attribute extraction', () => {
  it('extracts `#[inline]` attribute text onto the function occurrence decorators', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/lib.rs'), `#[inline]\npub fn fast() -> i32 { 1 }\n`, 'utf8');
    const { walk } = runAdapter();
    const fast = walk.occurrences.fast?.[0];
    expect(fast).toBeDefined();
    expect(fast?.decorators.some((d) => d.includes('#[inline]'))).toBe(true);
  });
});

describe('lang-rust walk.ts — trait method declarations', () => {
  it('records provided (default) methods declared inside a `trait` block', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    // A trait with a default method body — the function_item lives inside
    // a `trait_item` (not an `impl_item`), so enclosingImpl stays null and
    // the method is recorded as a function-declaration owned by module-init.
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `pub trait Greeter {\n` + `    fn greet(&self) -> i32 { 7 }\n` + `}\n`,
      'utf8',
    );
    const { walk } = runAdapter();
    const greet = walk.occurrences.greet?.[0];
    expect(greet).toBeDefined();
    // Not inside an impl → enclosingClass null, function-declaration kind.
    expect(greet?.enclosingClass).toBe(null);
    expect(greet?.kind).toBe('function-declaration');
  });
});
