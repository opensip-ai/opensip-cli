/**
 * Tests for the Go adapter's module-level depends_on edge emission.
 * Phase 4 Task 4.4 of opensip's substrate consolidation (opensip DEC-498).
 *
 * Exercises the full adapter contract surface (discoverFiles →
 * parseProject → walkProject → resolveCallSites) against small fixtures
 * with internal + external + aliased + blank + grouped imports, plus
 * `go.mod`-driven module-path resolution.
 *
 * Mirrors the Python adapter's Task 4.3 test layout.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { goGraphAdapter } from '../index.js';

import type { Catalog, FunctionOccurrence } from '@opensip-tools/graph';

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'graph-go-depends-on-'));
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
  const discovery = goGraphAdapter.discoverFiles({ cwd: fixtureRoot });
  const parsed = goGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
  });
  const walked = goGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  const initialCatalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'go',
    builtAt: new Date().toISOString(),
    cacheKey: 'test',
    functions: walked.occurrences,
  };
  const resolved = goGraphAdapter.resolveCallSites({
    project: parsed.project,
    catalog: initialCatalog,
    callSites: walked.callSites,
    dependencySites: walked.dependencySites,
    projectDirAbs: discovery.projectDirAbs,
  });
  return { catalog: initialCatalog, dependenciesByOwner: resolved.dependenciesByOwner };
}

const GO_MOD = `module github.com/example/myproj\n\ngo 1.22\n`;

describe('Go adapter — depends_on emission (Phase 4)', () => {
  it('resolves a single internal import to the target package module-init', () => {
    writeFile('go.mod', GO_MOD);
    writeFile(
      'main.go',
      `package main\n\nimport "github.com/example/myproj/pkg/foo"\n\nfunc main() {\n\tfoo.Do()\n}\n`,
    );
    writeFile('pkg/foo/foo.go', `package foo\n\nfunc Do() int { return 1 }\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'main.go');
    const fooInit = findModuleInit(catalog, 'pkg/foo/foo.go');

    expect(mainInit, 'main module-init').toBeDefined();
    expect(fooInit, 'foo module-init').toBeDefined();
    expect(dependenciesByOwner, 'dependenciesByOwner').toBeDefined();

    const mainDeps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(mainDeps, 'main has dependency edges').toHaveLength(1);
    expect(mainDeps![0]!.specifier).toBe('github.com/example/myproj/pkg/foo');
    expect(mainDeps![0]!.to).toEqual([fooInit!.bodyHash]);
    expect(mainDeps![0]!.line).toBe(3);
  });

  it('resolves an internal import targeting a multi-file package to all members', () => {
    writeFile('go.mod', GO_MOD);
    writeFile(
      'main.go',
      `package main\n\nimport "github.com/example/myproj/pkg/foo"\n\nfunc main() {\n\tfoo.Do()\n}\n`,
    );
    writeFile('pkg/foo/foo.go', `package foo\n\nfunc Do() int { return 1 }\n`);
    writeFile('pkg/foo/helpers.go', `package foo\n\nfunc Helper() int { return 2 }\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'main.go');
    const fooInit = findModuleInit(catalog, 'pkg/foo/foo.go');
    const helpersInit = findModuleInit(catalog, 'pkg/foo/helpers.go');

    expect(mainInit).toBeDefined();
    expect(fooInit).toBeDefined();
    expect(helpersInit).toBeDefined();

    const mainDeps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(mainDeps).toHaveLength(1);
    expect(mainDeps![0]!.specifier).toBe('github.com/example/myproj/pkg/foo');
    const targets = [...mainDeps![0]!.to].sort();
    const expected = [fooInit!.bodyHash, helpersInit!.bodyHash].sort();
    expect(targets).toEqual(expected);
  });

  it('emits unresolved edges for stdlib imports', () => {
    writeFile('go.mod', GO_MOD);
    writeFile(
      'main.go',
      `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'main.go');
    expect(mainInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0]!.specifier).toBe('fmt');
    expect(deps![0]!.to).toEqual([]);
  });

  it('emits unresolved edges for third-party external imports', () => {
    writeFile('go.mod', GO_MOD);
    writeFile(
      'main.go',
      `package main\n\nimport "github.com/external/somelib"\n\nfunc main() {\n\tsomelib.Run()\n}\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'main.go');
    expect(mainInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0]!.specifier).toBe('github.com/external/somelib');
    expect(deps![0]!.to).toEqual([]);
  });

  it('handles grouped imports — emits one dep site per import_spec', () => {
    writeFile('go.mod', GO_MOD);
    writeFile(
      'main.go',
      [
        'package main',
        '',
        'import (',
        '\t"fmt"',
        '\t"github.com/example/myproj/pkg/a"',
        '\talias "github.com/external/lib"',
        ')',
        '',
        'func main() {',
        '\tfmt.Println(a.Value)',
        '\talias.Use()',
        '}',
        '',
      ].join('\n'),
    );
    writeFile('pkg/a/a.go', `package a\n\nvar Value = 1\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'main.go');
    const aInit = findModuleInit(catalog, 'pkg/a/a.go');

    expect(mainInit).toBeDefined();
    expect(aInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(3);

    const specifiers = deps!.map((d) => d.specifier).sort();
    expect(specifiers).toEqual([
      'fmt',
      'github.com/example/myproj/pkg/a',
      'github.com/external/lib',
    ]);

    const fmtEdge = deps!.find((d) => d.specifier === 'fmt')!;
    expect(fmtEdge.to).toEqual([]);
    const aEdge = deps!.find((d) => d.specifier === 'github.com/example/myproj/pkg/a')!;
    expect(aEdge.to).toEqual([aInit!.bodyHash]);
    const aliasEdge = deps!.find((d) => d.specifier === 'github.com/external/lib')!;
    expect(aliasEdge.to).toEqual([]);
  });

  it('treats aliased imports the same as unaliased (alias does not change target)', () => {
    writeFile('go.mod', GO_MOD);
    writeFile(
      'main.go',
      `package main\n\nimport f "github.com/example/myproj/pkg/foo"\n\nfunc main() {\n\tf.Do()\n}\n`,
    );
    writeFile('pkg/foo/foo.go', `package foo\n\nfunc Do() int { return 1 }\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'main.go');
    const fooInit = findModuleInit(catalog, 'pkg/foo/foo.go');

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0]!.specifier).toBe('github.com/example/myproj/pkg/foo');
    expect(deps![0]!.to).toEqual([fooInit!.bodyHash]);
  });

  it('emits dependency edges for blank imports (`_ "path"`) like any other', () => {
    writeFile('go.mod', GO_MOD);
    writeFile(
      'main.go',
      `package main\n\nimport _ "github.com/example/myproj/pkg/sideeffect"\n\nfunc main() {}\n`,
    );
    writeFile('pkg/sideeffect/init.go', `package sideeffect\n\nfunc init() {}\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'main.go');
    const sideInit = findModuleInit(catalog, 'pkg/sideeffect/init.go');

    expect(mainInit).toBeDefined();
    expect(sideInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0]!.specifier).toBe('github.com/example/myproj/pkg/sideeffect');
    expect(deps![0]!.to).toEqual([sideInit!.bodyHash]);
  });

  it('produces no dependency edges for a file with no imports', () => {
    writeFile('go.mod', GO_MOD);
    writeFile('standalone.go', `package main\n\nfunc Standalone() int { return 42 }\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const standaloneInit = findModuleInit(catalog, 'standalone.go');
    expect(standaloneInit).toBeDefined();

    const deps = dependenciesByOwner?.get(standaloneInit!.bodyHash);
    expect(deps).toBeUndefined();
  });

  it('treats all imports as unresolved when go.mod is missing', () => {
    // No go.mod written — module path is unknown, so every import is
    // treated as external.
    writeFile(
      'main.go',
      `package main\n\nimport "github.com/example/myproj/pkg/foo"\n\nfunc main() {\n\tfoo.Do()\n}\n`,
    );
    writeFile('pkg/foo/foo.go', `package foo\n\nfunc Do() int { return 1 }\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'main.go');
    expect(mainInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0]!.specifier).toBe('github.com/example/myproj/pkg/foo');
    expect(deps![0]!.to).toEqual([]);
  });
});
