/**
 * Targeted branch-coverage tests for graph-go.
 *
 * These tests hit branches not exercised by the main test files:
 *   - resolve.ts:194 — go.mod with blank lines and `//` comments before
 *     the `module` directive (covers both operands of the OR).
 *   - resolve.ts:221 — import path equals the module path exactly (bare
 *     module import, no trailing subdirectory).
 *   - walk.ts skipBlockComment loop-exit branch — an unterminated `/*`
 *     block comment that runs to EOF.
 *   - walk.ts grouped-import without parens (single `import` form) —
 *     exercises the `import_spec` (not `import_spec_list`) branch of
 *     collectFromImportDeclaration in a way the existing tests don't
 *     already drive in isolation.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { goGraphAdapter } from '../index.js';

import type { Catalog, FunctionOccurrence } from '@opensip-tools/graph';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-go-branch-cov-'));
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
  readonly catalog: Catalog;
  readonly dependenciesByOwner:
    | ReadonlyMap<string, readonly { readonly to: readonly string[]; readonly specifier: string }[]>
    | undefined;
} {
  const discovery = goGraphAdapter.discoverFiles({ cwd: dir });
  const parsed = goGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  const walked = goGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'go',
    builtAt: '2026-05-27T00:00:00.000Z',
    cacheKey: 'test',
    functions: walked.occurrences,
  };
  const resolved = goGraphAdapter.resolveCallSites({
    project: parsed.project,
    catalog,
    callSites: walked.callSites,
    dependencySites: walked.dependencySites,
    projectDirAbs: discovery.projectDirAbs,
    resolutionMode: 'exact',
  });
  return { catalog, dependenciesByOwner: resolved.dependenciesByOwner };
}

describe('graph-go branch coverage', () => {
  it('readGoModulePath skips blank lines and // comments before the module directive', () => {
    // Blank line + `//` comment line + the module directive. This drives
    // both operands of the `length === 0 || startsWith('//')` short-circuit
    // in readGoModulePath.
    writeFileSync(
      join(dir, 'go.mod'),
      `\n// a leading comment\n\nmodule github.com/example/myproj\n\ngo 1.22\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'main.go'),
      `package main\n\nimport "github.com/example/myproj"\n\nfunc main() {}\n`,
      'utf8',
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'main.go');
    expect(mainInit).toBeDefined();

    // Resolution worked → the `module` line was found despite the comment
    // and blank lines before it.
    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('github.com/example/myproj');
  });

  it('readGoModulePath handles quoted module path (module "<path>")', () => {
    // Exercises the `match[2]` branch of `match[2] ?? match[3] ?? null`
    // in readGoModulePath (the quoted-form capture group).
    writeFileSync(
      join(dir, 'go.mod'),
      `module "github.com/example/quoted"\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nimport "github.com/example/quoted"\nfunc main() {}\n`,
      'utf8',
    );
    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'main.go');
    expect(mainInit).toBeDefined();
    // The bare-module import should resolve to the package members at the
    // project root — i.e. main.go's own module-init.
    const deps = dependenciesByOwner?.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].to).toEqual([mainInit!.bodyHash]);
  });

  it('resolves an import path that EQUALS the module path (bare module import)', () => {
    // Covers the `specifier === modulePath` branch in resolveGoImportPath.
    writeFileSync(
      join(dir, 'go.mod'),
      `module github.com/example/myproj\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'main.go'),
      `package main\n\nimport "github.com/example/myproj"\n\nfunc main() {}\n`,
      'utf8',
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'main.go');
    expect(mainInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('github.com/example/myproj');
    // The module path itself maps to package members at the project root.
    expect(deps![0].to).toEqual([mainInit!.bodyHash]);
  });

  it('stripGoComments tolerates an unterminated /* block comment (runs to EOF)', () => {
    // The `/*` is never closed — skipBlockComment's while-loop exits via
    // its condition becoming false (i >= text.length), exercising the
    // loop-exit branch.
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc unterminated() int { return 1 /* trailing comment that never closes`,
      'utf8',
    );
    const discovery = goGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = goGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    });
    const walked = goGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    // The file is malformed but the walker must not throw — it should
    // emit whatever it can. We just assert no exception and that the
    // module-init was produced.
    expect(walked.parseErrors).toEqual([]);
    const moduleInits = Object.keys(walked.occurrences).filter((n) => n.startsWith('<module-init:'));
    expect(moduleInits.length).toBe(1);
  });
});
