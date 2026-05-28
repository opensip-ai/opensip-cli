/**
 * Tests for the Python adapter's module-level depends_on edge emission.
 * Phase 4 Task 4.3 of opensip's substrate consolidation (opensip DEC-498).
 *
 * Exercises the full adapter contract surface (discoverFiles →
 * parseProject → walkProject → resolveCallSites) against a small
 * fixture with internal + relative + external imports, then asserts:
 *
 *   1. walkProject returns dependencySites populated with the right
 *      specifier + line + owner module-init bodyHash.
 *   2. resolveCallSites returns dependenciesByOwner with a resolved
 *      target bodyHash for in-project imports (absolute and relative).
 *   3. External / stdlib imports resolve to `to: []` (unresolved).
 *   4. The specifier is preserved on every edge regardless of
 *      resolution.
 *   5. Files with no imports do not appear in dependenciesByOwner.
 *
 * Mirrors the TypeScript adapter's Task 4.2 test layout.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pythonGraphAdapter } from '../index.js';

import type { Catalog, FunctionOccurrence } from '@opensip-tools/graph';

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'graph-python-depends-on-'));
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
  const discovery = pythonGraphAdapter.discoverFiles({ cwd: fixtureRoot });
  const parsed = pythonGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
  });
  const walked = pythonGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  // Build a minimal catalog from walked occurrences for the resolver
  // to query against (matches the engine's pipeline: stage 1 inventory
  // → stage 2 resolve).
  const initialCatalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'python',
    builtAt: new Date().toISOString(),
    cacheKey: 'test',
    functions: walked.occurrences,
  };
  const resolved = pythonGraphAdapter.resolveCallSites({
    project: parsed.project,
    catalog: initialCatalog,
    callSites: walked.callSites,
    dependencySites: walked.dependencySites,
    projectDirAbs: discovery.projectDirAbs,
  });
  return { catalog: initialCatalog, dependenciesByOwner: resolved.dependenciesByOwner };
}

describe('Python adapter — depends_on emission (Phase 4)', () => {
  it('resolves a simple internal `from … import …`', () => {
    writeFile(
      'greet.py',
      `from format import format_name\n\ndef greet(name):\n    return format_name(name)\n`,
    );
    writeFile('format.py', `def format_name(raw):\n    return raw.strip()\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const greetInit = findModuleInit(catalog, 'greet.py');
    const formatInit = findModuleInit(catalog, 'format.py');

    expect(greetInit, 'greet module-init').toBeDefined();
    expect(formatInit, 'format module-init').toBeDefined();
    expect(dependenciesByOwner, 'dependenciesByOwner').toBeDefined();

    const greetDeps = dependenciesByOwner!.get(greetInit!.bodyHash);
    expect(greetDeps, 'greet has dependency edges').toHaveLength(1);
    expect(greetDeps![0]!.specifier).toBe('format');
    expect(greetDeps![0]!.to).toEqual([formatInit!.bodyHash]);
    expect(greetDeps![0]!.line).toBe(1);
  });

  it('resolves a dotted-module `import pkg.helpers`', () => {
    writeFile('main.py', `import pkg.helpers\n\ndef run():\n    return pkg.helpers.do()\n`);
    writeFile('pkg/__init__.py', '');
    writeFile('pkg/helpers.py', `def do():\n    return 1\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'main.py');
    const helpersInit = findModuleInit(catalog, 'pkg/helpers.py');

    expect(mainInit).toBeDefined();
    expect(helpersInit).toBeDefined();

    const mainDeps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(mainDeps).toHaveLength(1);
    expect(mainDeps![0]!.specifier).toBe('pkg.helpers');
    expect(mainDeps![0]!.to).toEqual([helpersInit!.bodyHash]);
  });

  it('resolves a same-package relative import `from . import sibling`', () => {
    writeFile('pkg/__init__.py', '');
    writeFile('pkg/a.py', `from . import b\n\ndef use():\n    return b.value\n`);
    writeFile('pkg/b.py', `value = 1\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const aInit = findModuleInit(catalog, 'pkg/a.py');
    const bInit = findModuleInit(catalog, 'pkg/b.py');

    expect(aInit).toBeDefined();
    expect(bInit).toBeDefined();

    const aDeps = dependenciesByOwner!.get(aInit!.bodyHash);
    expect(aDeps).toHaveLength(1);
    expect(aDeps![0]!.specifier).toBe('.b');
    expect(aDeps![0]!.to).toEqual([bInit!.bodyHash]);
  });

  it('resolves a parent-package relative import `from ..helpers import x`', () => {
    writeFile('pkg/__init__.py', '');
    writeFile('pkg/helpers.py', `def x():\n    return 1\n`);
    writeFile('pkg/sub/__init__.py', '');
    writeFile('pkg/sub/a.py', `from ..helpers import x\n\ndef use():\n    return x()\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const aInit = findModuleInit(catalog, 'pkg/sub/a.py');
    const helpersInit = findModuleInit(catalog, 'pkg/helpers.py');

    expect(aInit).toBeDefined();
    expect(helpersInit).toBeDefined();

    const aDeps = dependenciesByOwner!.get(aInit!.bodyHash);
    expect(aDeps).toHaveLength(1);
    expect(aDeps![0]!.specifier).toBe('..helpers');
    expect(aDeps![0]!.to).toEqual([helpersInit!.bodyHash]);
  });

  it('emits unresolved edges for external / stdlib imports', () => {
    writeFile(
      'main.py',
      `import os\nfrom numpy import array\n\ndef run():\n    return os.getcwd()\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'main.py');
    expect(mainInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(2);

    const osEdge = deps!.find((d) => d.specifier === 'os');
    expect(osEdge).toBeDefined();
    expect(osEdge!.to).toEqual([]);

    const numpyEdge = deps!.find((d) => d.specifier === 'numpy');
    expect(numpyEdge).toBeDefined();
    expect(numpyEdge!.to).toEqual([]);
  });

  it('preserves multiple imports as separate dependency edges grouped under one owner', () => {
    writeFile('a.py', `def fa():\n    return 1\n`);
    writeFile('b.py', `def fb():\n    return 2\n`);
    writeFile(
      'main.py',
      [
        'from a import fa',
        'from b import fb',
        'import sys',
        '',
        'def run():',
        '    return fa() + fb() + len(sys.argv)',
        '',
      ].join('\n'),
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'main.py');
    expect(mainInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(3);

    const specifiers = deps!.map((d) => d.specifier).sort();
    expect(specifiers).toEqual(['a', 'b', 'sys']);

    const aEdge = deps!.find((d) => d.specifier === 'a');
    expect(aEdge!.to).toHaveLength(1);
    const bEdge = deps!.find((d) => d.specifier === 'b');
    expect(bEdge!.to).toHaveLength(1);
    const sysEdge = deps!.find((d) => d.specifier === 'sys');
    expect(sysEdge!.to).toEqual([]);
  });

  it('produces no dependency edges for a file with no imports', () => {
    writeFile('standalone.py', `def standalone():\n    return 42\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const standaloneInit = findModuleInit(catalog, 'standalone.py');
    expect(standaloneInit).toBeDefined();

    // No dependency edges → owner not in the map at all.
    const deps = dependenciesByOwner?.get(standaloneInit!.bodyHash);
    expect(deps).toBeUndefined();
  });
});
