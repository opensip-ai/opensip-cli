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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { typescriptGraphAdapter } from '../index.js';

import type { Catalog, FunctionOccurrence } from '@opensip-tools/graph';

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

function runAdapter(): { catalog: Catalog; dependenciesByOwner: ReadonlyMap<string, readonly { readonly to: readonly string[]; readonly specifier: string; readonly line: number; readonly column: number }[]> | undefined } {
  const discovery = typescriptGraphAdapter.discoverFiles({
    cwd: fixtureRoot,
  });
  const parsed = typescriptGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  const walked = typescriptGraphAdapter.walkProject({
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
  const resolved = typescriptGraphAdapter.resolveCallSites({
    project: parsed.project,
    catalog: initialCatalog,
    callSites: walked.callSites,
    dependencySites: walked.dependencySites,
    projectDirAbs: discovery.projectDirAbs,
    resolutionMode: 'exact',
  });
  return { catalog: initialCatalog, dependenciesByOwner: resolved.dependenciesByOwner };
}

describe('TypeScript adapter — depends_on emission (Phase 4)', () => {
  it('walks an ImportDeclaration as a dependency site on the importing file', () => {
    writeFile(
      'src/greet.ts',
      `import { formatName } from './format.js';\nexport function greet(name: string): string { return formatName(name); }\n`,
    );
    writeFile(
      'src/format.ts',
      `export function formatName(raw: string): string { return raw.trim(); }\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const greetModuleInit = findModuleInit(catalog, 'src/greet.ts');
    const formatModuleInit = findModuleInit(catalog, 'src/format.ts');

    expect(greetModuleInit, 'greet module-init').toBeDefined();
    expect(formatModuleInit, 'format module-init').toBeDefined();
    expect(dependenciesByOwner, 'dependenciesByOwner').toBeDefined();

    const greetDeps = dependenciesByOwner!.get(greetModuleInit!.bodyHash);
    expect(greetDeps, 'greet has dependency edges').toHaveLength(1);
    expect(greetDeps![0].specifier).toBe('./format.js');
    expect(greetDeps![0].to).toEqual([formatModuleInit!.bodyHash]);
    expect(greetDeps![0].line).toBe(1);
  });

  it('emits an unresolved edge for external package imports', () => {
    writeFile(
      'src/greet.ts',
      `import { something } from '@opensip-tools/nonexistent-pkg';\nexport function greet(): string { return String(something); }\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const greetModuleInit = findModuleInit(catalog, 'src/greet.ts');
    expect(greetModuleInit).toBeDefined();

    const greetDeps = dependenciesByOwner!.get(greetModuleInit!.bodyHash);
    expect(greetDeps).toHaveLength(1);
    expect(greetDeps![0].specifier).toBe('@opensip-tools/nonexistent-pkg');
    expect(greetDeps![0].to).toEqual([]);
  });

  it('preserves multiple imports as separate dependency edges', () => {
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

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainModuleInit = findModuleInit(catalog, 'src/main.ts');
    expect(mainModuleInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainModuleInit!.bodyHash);
    expect(deps).toHaveLength(3);

    const specifiers = deps!.map((d) => d.specifier).sort();
    expect(specifiers).toEqual(['./a.js', './b.js', '@external/pkg']);

    const externalEdge = deps!.find((d) => d.specifier === '@external/pkg');
    expect(externalEdge!.to).toEqual([]);

    const aEdge = deps!.find((d) => d.specifier === './a.js');
    expect(aEdge!.to).toHaveLength(1);
  });

  it('produces no dependency edges for a file with no imports', () => {
    writeFile(
      'src/standalone.ts',
      `export function standalone(): number { return 42; }\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const standaloneModuleInit = findModuleInit(catalog, 'src/standalone.ts');
    expect(standaloneModuleInit).toBeDefined();

    // No dependency edges → owner not in the map at all.
    const deps = dependenciesByOwner?.get(standaloneModuleInit!.bodyHash);
    expect(deps).toBeUndefined();
  });

  it('captures import line numbers (1-based) for source attribution', () => {
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

    const { catalog, dependenciesByOwner } = runAdapter();
    const moduleInit = findModuleInit(catalog, 'src/multiline.ts');
    const deps = dependenciesByOwner!.get(moduleInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].line).toBe(3);
  });
});
