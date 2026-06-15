/**
 * Targeted branch-coverage tests for the Python graph adapter.
 *
 * These exercise import-shape and resolution branches that the
 * happy-path suites in walk-shapes / depends-on-emission / resolve
 * don't reach:
 *
 *   - walk-dependencies.ts: aliased imports (`import foo as f`),
 *     wildcard from-imports (`from foo import *`), relative wildcard
 *     (`from . import *`, which emits no dotted name), and from-imports
 *     whose module-name resolves to neither a dotted_name nor a
 *     relative_import.
 *   - resolve.ts: relative imports that walk above the project root
 *     (unresolvable → `[]`), root-level relative imports (`baseDir`
 *     collapses to project root), and the dependency-site resolution
 *     path threaded through resolveCallSites.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pythonGraphAdapter } from '../index.js';
import { resolveCallSites } from '../resolve.js';

import type { PythonParsedFile, PythonParsedProject } from '../parse.js';
import type {
  Catalog,
  DependencyEdge,
  DependencySiteRecord,
  FunctionOccurrence,
} from '@opensip-cli/graph';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-python-branch-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function runWalk(): {
  dependencySites: readonly DependencySiteRecord[];
  occurrences: Record<string, FunctionOccurrence[]>;
} {
  const discovery = pythonGraphAdapter.discoverFiles({ cwd: dir });
  const parsed = pythonGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  const walk = pythonGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  // The Python walker always populates dependencySites (one site per
  // top-level import); the engine's WalkOutput type marks it optional.
  return { dependencySites: walk.dependencySites ?? [], occurrences: walk.occurrences };
}

function findModuleInit(catalog: Catalog, filePath: string): FunctionOccurrence | undefined {
  for (const occs of Object.values(catalog.functions)) {
    for (const o of occs) {
      if (o.kind === 'module-init' && o.filePath === filePath) return o;
    }
  }
  return undefined;
}

function resolveDeps(): {
  catalog: Catalog;
  byOwner: ReadonlyMap<string, readonly DependencyEdge[]> | undefined;
} {
  const discovery = pythonGraphAdapter.discoverFiles({ cwd: dir });
  const parsed = pythonGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  const walk = pythonGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'python',
    cacheKey: 'test',
    builtAt: new Date().toISOString(),
    functions: walk.occurrences,
  };
  const resolved = pythonGraphAdapter.resolveCallSites({
    project: parsed.project,
    catalog,
    callSites: walk.callSites,
    dependencySites: walk.dependencySites,
    projectDirAbs: discovery.projectDirAbs,
    resolutionMode: 'exact',
  });
  return { catalog, byOwner: resolved.dependenciesByOwner };
}

function buildPipeline(): {
  project: PythonParsedProject;
  catalog: Catalog;
  projectDirAbs: string;
  firstFile: PythonParsedFile;
  moduleInitHash: string;
} {
  const discovery = pythonGraphAdapter.discoverFiles({ cwd: dir });
  const parsed = pythonGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  const walk = pythonGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'python',
    cacheKey: 'test',
    builtAt: new Date().toISOString(),
    functions: walk.occurrences,
  };
  const firstFile = parsed.project.files.get(discovery.files[0])!;
  let moduleInitHash = '';
  for (const occs of Object.values(walk.occurrences)) {
    for (const o of occs) if (o.kind === 'module-init') moduleInitHash = o.bodyHash;
  }
  return {
    project: parsed.project,
    catalog,
    projectDirAbs: discovery.projectDirAbs,
    firstFile,
    moduleInitHash,
  };
}

describe('walk-dependencies.ts — import-shape branches', () => {
  it('emits a dep site for an aliased import (`import foo as f`)', () => {
    writeFile('main.py', `import foo as f\n\ndef run():\n    return f.go()\n`);
    writeFile('foo.py', `def go():\n    return 1\n`);
    const walk = runWalk();
    const specs = walk.dependencySites.map((s) => s.specifier);
    expect(specs).toContain('foo');
  });

  it('emits a single dep site for a dotted aliased import (`import a.b.c as x`)', () => {
    writeFile('main.py', `import a.b.c as x\n`);
    const walk = runWalk();
    const specs = walk.dependencySites.map((s) => s.specifier);
    expect(specs).toEqual(['a.b.c']);
  });

  it('emits one dep site for a wildcard from-import (`from foo import *`)', () => {
    writeFile('main.py', `from foo import *\n`);
    writeFile('foo.py', `x = 1\n`);
    const walk = runWalk();
    const specs = walk.dependencySites.map((s) => s.specifier);
    // Wildcard is treated like any from-import: one site on the source module.
    expect(specs).toEqual(['foo']);
  });

  it('emits no dotted dep site for a relative wildcard import (`from . import *`)', () => {
    // `from . import *` has a relative_import (dots-only) module-name and
    // a wildcard child that resolves to no dotted_name — so the per-name
    // loop emits nothing.
    writeFile('pkg/__init__.py', '');
    writeFile('pkg/a.py', `from . import *\n`);
    const walk = runWalk();
    const aSites = walk.dependencySites.filter((s) =>
      (s.sourceFileRef as { source: string }).source.includes('from . import'),
    );
    expect(aSites).toHaveLength(0);
  });

  it('emits one dep site each for a mixed comma import (`import a, b.c`)', () => {
    writeFile('main.py', `import a, b.c\n`);
    const walk = runWalk();
    const specs = walk.dependencySites.map((s) => s.specifier).sort();
    expect(specs).toEqual(['a', 'b.c']);
  });

  it('emits multiple per-name dep sites for `from . import x, y`', () => {
    writeFile('pkg/__init__.py', '');
    writeFile('pkg/a.py', `from . import x, y\n`);
    writeFile('pkg/x.py', `xv = 1\n`);
    writeFile('pkg/y.py', `yv = 2\n`);
    const walk = runWalk();
    const specs = walk.dependencySites.map((s) => s.specifier).sort();
    expect(specs).toEqual(['.x', '.y']);
  });
});

describe('walk.ts — parameter-field branches', () => {
  it('returns empty params for a no-parameter lambda (`lambda: 42`)', () => {
    // A bare `lambda: 42` has no `parameters` field at all, exercising
    // the null-params guard in extractParamsFromField.
    writeFile('main.py', `f = lambda: 42\n`);
    const walk = runWalk();
    const arrowKey = Object.keys(walk.occurrences).find((k) => k.startsWith('<arrow:'));
    expect(arrowKey).toBeDefined();
    const arrow = walk.occurrences[arrowKey!]?.[0];
    expect(arrow?.kind).toBe('arrow');
    expect(arrow?.params).toEqual([]);
  });

  it('returns empty params for a no-parameter function (`def g():`)', () => {
    writeFile('main.py', `def g():\n    return 1\n`);
    const walk = runWalk();
    expect(walk.occurrences.g?.[0]?.params).toEqual([]);
  });
});

describe('resolve.ts — relative-import resolution branches', () => {
  it('returns [] for a relative import that walks above the project root', () => {
    // `from ..pkg import x` in a file at the project root: walking up two
    // package levels from the root leaves the project → unresolvable.
    writeFile('a.py', `from ..pkg import x\n\ndef f():\n    return 1\n`);
    const { catalog, byOwner } = resolveDeps();
    const aInit = findModuleInit(catalog, 'a.py');
    expect(aInit).toBeDefined();
    const deps = byOwner!.get(aInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('..pkg');
    expect(deps![0].to).toEqual([]);
  });

  it('resolves a root-level `from . import sibling` (baseDir collapses to root)', () => {
    // Importer at project root: importer dir is '.', so the relative
    // prefix is empty and the sibling resolves directly under root.
    writeFile('a.py', `from . import b\n`);
    writeFile('b.py', `bv = 1\n`);
    const { catalog, byOwner } = resolveDeps();
    const aInit = findModuleInit(catalog, 'a.py');
    const bInit = findModuleInit(catalog, 'b.py');
    expect(aInit).toBeDefined();
    expect(bInit).toBeDefined();
    const deps = byOwner!.get(aInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('.b');
    expect(deps![0].to).toEqual([bInit!.bodyHash]);
  });

  it('returns [] for a dots-only relative specifier (`from . import` with no module name)', () => {
    // A bare-dot specifier has an empty module-name remainder, so the
    // segment list collapses to empty and resolves to nothing. We craft
    // the dependency site directly because the walker always appends an
    // imported name to the dot prefix.
    writeFile('a.py', `x = 1\n`);
    const { project, catalog, projectDirAbs, firstFile, moduleInitHash } = buildPipeline();
    const resolved = resolveCallSites({
      project,
      catalog,
      callSites: [],
      dependencySites: [
        {
          nodeRef: firstFile.tree.rootNode,
          sourceFileRef: firstFile,
          ownerHash: moduleInitHash,
          specifier: '.',
          line: 1,
          column: 0,
        },
      ],
      projectDirAbs,
      resolutionMode: 'exact',
    });
    const deps = resolved.dependenciesByOwner!.get(moduleInitHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('.');
    expect(deps![0].to).toEqual([]);
  });

  it('skips a creation call site that is missing its childHash', () => {
    // A creation edge with no childHash is malformed; the resolver
    // defensively skips it rather than emitting a dangling edge.
    writeFile('a.py', `x = 1\n`);
    const { project, catalog, projectDirAbs, firstFile, moduleInitHash } = buildPipeline();
    const resolved = resolveCallSites({
      project,
      catalog,
      callSites: [
        {
          nodeRef: firstFile.tree.rootNode,
          sourceFileRef: firstFile,
          ownerHash: moduleInitHash,
          kind: 'creation',
          // childHash intentionally omitted
        },
      ],
      projectDirAbs,
      resolutionMode: 'exact',
    });
    // No edge emitted for the malformed creation site.
    expect(resolved.edgesByOwner.get(moduleInitHash)).toBeUndefined();
    expect(resolved.stats.totalCallSites).toBe(0);
  });

  it('resolves a dotted module to its package __init__.py form', () => {
    // `import pkg` (no submodule) → pkg/__init__.py is the second
    // candidate form in lookupModuleCandidates.
    writeFile('main.py', `import pkg\n`);
    writeFile('pkg/__init__.py', `pv = 1\n`);
    const { catalog, byOwner } = resolveDeps();
    const mainInit = findModuleInit(catalog, 'main.py');
    const pkgInit = findModuleInit(catalog, 'pkg/__init__.py');
    expect(mainInit).toBeDefined();
    expect(pkgInit).toBeDefined();
    const deps = byOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('pkg');
    expect(deps![0].to).toEqual([pkgInit!.bodyHash]);
  });
});
