/**
 * Tests for the TypeScript adapter's module-level depends_on edge
 * emission. Phase 4 Task 4.2 of opensip's substrate consolidation
 * (opensip DEC-498).
 *
 * Exercises the full adapter contract surface (discoverFiles →
 * parseProject → walkProject → resolveCallSites) against a small
 * fixture with internal + external imports, then asserts:
 *
 *   1. walkProject returns dependencySites populated with the right
 *      specifier + line + owner module-init bodyHash.
 *   2. resolveCallSites returns dependenciesByOwner with a resolved
 *      target bodyHash for internal imports.
 *   3. External package imports resolve to `to: []` (unresolved).
 *   4. The specifier is preserved on every edge regardless of
 *      resolution.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isValidDependencyFormRole, ownerEdgeKey } from '@opensip-cli/graph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { typescriptGraphAdapter } from '../index.js';

import type { CallEdge, Catalog, DependencyEdge, FunctionOccurrence } from '@opensip-cli/graph';

const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
  },
  include: ['**/*.ts'],
});

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'graph-ts-depends-on-'));
  mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): void {
  writeFileSync(join(fixtureRoot, rel), content, 'utf8');
}

function findModuleInit(catalog: Catalog, filePath: string): FunctionOccurrence | undefined {
  for (const occs of Object.values(catalog.functions)) {
    for (const o of occs) {
      if (o.kind === 'module-init' && o.filePath === filePath) return o;
    }
  }
  return undefined;
}

function findOccurrence(catalog: Catalog, simpleName: string): FunctionOccurrence | undefined {
  for (const occs of Object.values(catalog.functions)) {
    for (const o of occs) {
      if (o.simpleName === simpleName) return o;
    }
  }
  return undefined;
}

function depsFor(
  dependenciesByOwner: ReadonlyMap<string, readonly DependencyEdge[]> | undefined,
  mi: FunctionOccurrence,
): readonly DependencyEdge[] | undefined {
  return dependenciesByOwner?.get(ownerEdgeKey(mi.bodyHash, mi.filePath, mi.line, mi.column));
}

async function runAdapter(): Promise<{
  catalog: Catalog;
  dependenciesByOwner: ReadonlyMap<string, readonly DependencyEdge[]> | undefined;
  edgesByOwner: ReadonlyMap<string, readonly CallEdge[]>;
}> {
  const discovery = await typescriptGraphAdapter.discoverFiles({
    cwd: fixtureRoot,
    diagnosticIntent: 'quiet',
  });
  const parsed = await typescriptGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  const walked = await typescriptGraphAdapter.walkProject({
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
    language: 'typescript',
    builtAt: new Date().toISOString(),
    cacheKey: 'test',
    functions: walked.occurrences,
  };
  const resolved = await typescriptGraphAdapter.resolveCallSites({
    project: parsed.project,
    catalog: initialCatalog,
    callSites: walked.callSites,
    dependencySites: walked.dependencySites,
    projectDirAbs: discovery.projectDirAbs,
    resolutionMode: 'exact',
  });
  return {
    catalog: initialCatalog,
    dependenciesByOwner: resolved.dependenciesByOwner,
    edgesByOwner: resolved.edgesByOwner,
  };
}

describe('TypeScript adapter — depends_on emission (Phase 4)', () => {
  it('walks an ImportDeclaration as a dependency site on the importing file', async () => {
    writeFile(
      'src/greet.ts',
      `import { formatName } from './format.js';\nexport function greet(name: string): string { return formatName(name); }\n`,
    );
    writeFile(
      'src/format.ts',
      `export function formatName(raw: string): string { return raw.trim(); }\n`,
    );

    const { catalog, dependenciesByOwner } = await runAdapter();
    const greetModuleInit = findModuleInit(catalog, 'src/greet.ts');
    const formatModuleInit = findModuleInit(catalog, 'src/format.ts');

    expect(greetModuleInit, 'greet module-init').toBeDefined();
    expect(formatModuleInit, 'format module-init').toBeDefined();
    expect(dependenciesByOwner, 'dependenciesByOwner').toBeDefined();

    const greetDeps = dependenciesByOwner!.get(
      ownerEdgeKey(
        greetModuleInit!.bodyHash,
        greetModuleInit!.filePath,
        greetModuleInit!.line,
        greetModuleInit!.column,
      ),
    );
    expect(greetDeps, 'greet has dependency edges').toHaveLength(1);
    expect(greetDeps![0].specifier).toBe('./format.js');
    expect(greetDeps![0].to).toEqual([formatModuleInit!.bodyHash]);
    expect(greetDeps![0].line).toBe(1);
  });

  it('emits an unresolved edge for external package imports', async () => {
    writeFile(
      'src/greet.ts',
      `import { something } from '@opensip-cli/nonexistent-pkg';\nexport function greet(): string { return String(something); }\n`,
    );

    const { catalog, dependenciesByOwner } = await runAdapter();
    const greetModuleInit = findModuleInit(catalog, 'src/greet.ts');
    expect(greetModuleInit).toBeDefined();

    const greetDeps = dependenciesByOwner!.get(
      ownerEdgeKey(
        greetModuleInit!.bodyHash,
        greetModuleInit!.filePath,
        greetModuleInit!.line,
        greetModuleInit!.column,
      ),
    );
    expect(greetDeps).toHaveLength(1);
    expect(greetDeps![0].specifier).toBe('@opensip-cli/nonexistent-pkg');
    expect(greetDeps![0].to).toEqual([]);
  });

  it('preserves multiple imports as separate dependency edges', async () => {
    writeFile(
      'src/main.ts',
      [
        `import { a } from './a.js';`,
        `import { b } from './b.js';`,
        `import { c } from '@external/pkg';`,
        `export function main(): string { return a() + b() + String(c); }`,
        '',
      ].join('\n'),
    );
    writeFile('src/a.ts', `export function a(): string { return 'a'; }\n`);
    writeFile('src/b.ts', `export function b(): string { return 'b'; }\n`);

    const { catalog, dependenciesByOwner } = await runAdapter();
    const mainModuleInit = findModuleInit(catalog, 'src/main.ts');
    expect(mainModuleInit).toBeDefined();

    const deps = dependenciesByOwner!.get(
      ownerEdgeKey(
        mainModuleInit!.bodyHash,
        mainModuleInit!.filePath,
        mainModuleInit!.line,
        mainModuleInit!.column,
      ),
    );
    expect(deps).toHaveLength(3);

    const specifiers = deps!.map((d) => d.specifier).sort();
    expect(specifiers).toEqual(['./a.js', './b.js', '@external/pkg']);

    const externalEdge = deps!.find((d) => d.specifier === '@external/pkg');
    expect(externalEdge!.to).toEqual([]);

    const aEdge = deps!.find((d) => d.specifier === './a.js');
    expect(aEdge!.to).toHaveLength(1);
  });

  it('emits an explicit empty dependency array for a supported file with no imports', async () => {
    writeFile('src/standalone.ts', `export function standalone(): number { return 42; }\n`);

    const { catalog, dependenciesByOwner } = await runAdapter();
    const standaloneModuleInit = findModuleInit(catalog, 'src/standalone.ts');
    expect(standaloneModuleInit).toBeDefined();

    // Present-empty: the exact tier inspected this file and found no imports —
    // distinct from an unsupported adapter/tier (map absent). (P2 Phase 0.)
    expect(depsFor(dependenciesByOwner, standaloneModuleInit!)).toEqual([]);
  });

  it('captures import line numbers (1-based) for source attribution', async () => {
    writeFile(
      'src/multiline.ts',
      [
        `// header comment`,
        `// second comment`,
        `import { x } from './other.js';`,
        `export function fn(): unknown { return x; }`,
        '',
      ].join('\n'),
    );
    writeFile('src/other.ts', `export const x = 1;\n`);

    const { catalog, dependenciesByOwner } = await runAdapter();
    const moduleInit = findModuleInit(catalog, 'src/multiline.ts');
    const deps = dependenciesByOwner!.get(
      ownerEdgeKey(
        moduleInit!.bodyHash,
        moduleInit!.filePath,
        moduleInit!.line,
        moduleInit!.column,
      ),
    );
    expect(deps).toHaveLength(1);
    expect(deps![0].line).toBe(3);
  });
});

describe('TypeScript adapter — dependency classification (P2 Phase 0)', () => {
  it('classifies form + role for every import form and validates the pairs', async () => {
    writeFile('src/dep.ts', `export const value = 1;\nexport interface Shape { n: number }\n`);
    writeFile(
      'src/forms.ts',
      [
        `import { value } from './dep.js';`, // import-declaration, runtime
        `import type { Shape } from './dep.js';`, // import-declaration, type-only
        `import { type Shape as S2, value as v2 } from './dep.js';`, // import-declaration, mixed
        `import './dep.js';`, // import-declaration, side-effect
        `import equalsRuntime = require('./dep.js');`, // import-equals, runtime
        `import type equalsType = require('./dep.js');`, // import-equals, type-only
        `export { value as reValue } from './dep.js';`, // re-export, runtime
        `export type { Shape as ReShape } from './dep.js';`, // re-export, type-only
        `export { value as reMixed, type Shape as ReMixedShape } from './dep.js';`, // re-export, mixed
        `const lazy = () => import('./dep.js');`, // dynamic-import, runtime
        `const cjs = require('./dep.js');`, // commonjs-require, runtime
        `export function forms(): unknown { return [value, v2, S2, equalsRuntime, lazy, cjs]; }`,
        '',
      ].join('\n'),
    );
    const { catalog, dependenciesByOwner } = await runAdapter();
    const deps = depsFor(dependenciesByOwner, findModuleInit(catalog, 'src/forms.ts')!)!;

    // Every edge carries a complete, valid classification.
    for (const e of deps) {
      expect(e.classification, `classification on '${e.specifier}' @${e.line}`).toBeDefined();
      expect(isValidDependencyFormRole(e.classification!.form, e.classification!.role)).toBe(true);
    }

    const combos = deps.map((e) => `${e.classification!.form}:${e.classification!.role}`);
    for (const expected of [
      'import-declaration:runtime',
      'import-declaration:type-only',
      'import-declaration:mixed',
      'import-declaration:side-effect',
      'import-equals:runtime',
      'import-equals:type-only',
      're-export:runtime',
      're-export:type-only',
      're-export:mixed',
      'dynamic-import:runtime',
      'commonjs-require:runtime',
    ]) {
      expect(combos, `emitted ${expected}`).toContain(expected);
    }
  });

  it('rejects impossible form+role pairs at the closed validator', () => {
    // Closed map: producers must never emit these combinations; CatalogRepo
    // re-validates after JSON decode.
    expect(isValidDependencyFormRole('dynamic-import', 'type-only')).toBe(false);
    expect(isValidDependencyFormRole('dynamic-import', 'mixed')).toBe(false);
    expect(isValidDependencyFormRole('dynamic-import', 'side-effect')).toBe(false);
    expect(isValidDependencyFormRole('commonjs-require', 'type-only')).toBe(false);
    expect(isValidDependencyFormRole('import-equals', 'mixed')).toBe(false);
    expect(isValidDependencyFormRole('import-equals', 'side-effect')).toBe(false);
    expect(isValidDependencyFormRole('re-export', 'side-effect')).toBe(false);
    expect(isValidDependencyFormRole('import-declaration', 'runtime')).toBe(true);
    expect(isValidDependencyFormRole('import-equals', 'runtime')).toBe(true);
    expect(isValidDependencyFormRole('import-equals', 'type-only')).toBe(true);
    expect(isValidDependencyFormRole('re-export', 'mixed')).toBe(true);
  });

  it('classifies an internal import as catalog-source and an external as external', async () => {
    writeFile('src/dep.ts', `export const value = 1;\n`);
    writeFile(
      'src/main.ts',
      `import { value } from './dep.js';\nimport { z } from '@external/pkg';\nexport const m = [value, z];\n`,
    );
    const { catalog, dependenciesByOwner } = await runAdapter();
    const deps = depsFor(dependenciesByOwner, findModuleInit(catalog, 'src/main.ts')!)!;

    const internal = deps.find((e) => e.specifier === './dep.js')!;
    expect(internal.classification!.targetKind).toBe('catalog-source');
    expect(internal.classification!.basis).toBe('catalog-target');
    expect(internal.to).toHaveLength(1);
    expect(internal.classification!.resolvedPackage).toBeUndefined();

    const external = deps.find((e) => e.specifier === '@external/pkg')!;
    expect(external.classification!.targetKind).toBe('external');
    expect(external.to).toEqual([]);
    expect(external.classification!.resolvedPackage).toBeUndefined();
  });

  it('skips a nonliteral dynamic import / require, keeping only literal specifiers', async () => {
    writeFile('src/real.ts', `export const real = 1;\n`);
    writeFile(
      'src/dynamic.ts',
      [
        `const name = './real.js';`,
        `const a = () => import(name);`, // nonliteral — skipped
        `const b = require(name);`, // nonliteral — skipped
        `const c = () => import('./real.js');`, // literal — kept
        `export const d = [a, b, c];`,
        '',
      ].join('\n'),
    );
    const { catalog, dependenciesByOwner } = await runAdapter();
    const deps = depsFor(dependenciesByOwner, findModuleInit(catalog, 'src/dynamic.ts')!)!;
    expect(deps.map((e) => e.specifier)).toEqual(['./real.js']);
    expect(deps[0].classification!.form).toBe('dynamic-import');
  });

  it('resolves call and dependency edges from a single shared cross-package context', async () => {
    // One adapter run builds ONE CrossPackageContext (P2 Phase 0.4) and threads
    // it into BOTH call-edge resolution and dependency resolution. A file that
    // imports (dependency edge) AND calls into (call edge) an internal module
    // must resolve both — neither resolver rebuilds or clobbers the other's
    // context.
    writeFile('src/dep.ts', `export function used(): number { return 1; }\n`);
    writeFile(
      'src/main.ts',
      `import { used } from './dep.js';\nexport function callsUsed(): number { return used(); }\n`,
    );
    const { catalog, dependenciesByOwner, edgesByOwner } = await runAdapter();

    // Dependency edge: main.ts's module-init depends on the internal ./dep.js.
    const depEdge = depsFor(dependenciesByOwner, findModuleInit(catalog, 'src/main.ts')!)!.find(
      (e) => e.specifier === './dep.js',
    )!;
    expect(depEdge.classification!.targetKind).toBe('catalog-source');
    expect(depEdge.to).toHaveLength(1);

    // Call edge: callsUsed → used, resolved off the SAME run's shared context.
    const callsUsed = findOccurrence(catalog, 'callsUsed')!;
    const used = findOccurrence(catalog, 'used')!;
    const callEdges = edgesByOwner.get(
      ownerEdgeKey(callsUsed.bodyHash, callsUsed.filePath, callsUsed.line, callsUsed.column),
    );
    expect(callEdges?.some((e) => e.to.includes(used.bodyHash))).toBe(true);
  });
});
