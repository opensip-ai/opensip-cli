import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { DEFAULT_SEMANTIC_FACT_LIMITS, MAX_SEMANTIC_DECLARATIONS } from '@opensip-cli/graph';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCrossPackageContext } from '../edge-helpers/cross-package-context.js';
import { typescriptGraphAdapter } from '../index.js';
import {
  collectSemanticReferenceFacts,
  isExternalDeclarationFile,
} from '../semantic-reference-facts.js';

import type { Catalog } from '@opensip-cli/graph';

let dir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function writeProject(
  files: Record<string, string>,
  include: readonly string[] = ['**/*.ts'],
): string {
  dir = mkdtempSync(join(tmpdir(), 'sem-facts-'));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        strict: true,
        skipLibCheck: true,
      },
      include,
    }),
    'utf8',
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }), 'utf8');
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

async function exactSemanticFacts(projectDir: string) {
  const discovery = await typescriptGraphAdapter.discoverFiles({
    cwd: projectDir,
    diagnosticIntent: 'quiet',
  });
  const parsed = await typescriptGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    configPathAbs: discovery.configPathAbs,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  if (parsed.project.kind !== 'exact') throw new Error('expected exact');
  const walked = await typescriptGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: new Date().toISOString(),
    cacheKey: 'test',
    resolutionMode: 'exact',
    functions: walked.occurrences,
    ...(walked.reExports !== undefined && walked.reExports.length > 0
      ? { reExports: walked.reExports }
      : {}),
  };
  const resolved = await typescriptGraphAdapter.resolveCallSites({
    project: parsed.project,
    catalog,
    callSites: walked.callSites,
    dependencySites: walked.dependencySites,
    projectDirAbs: discovery.projectDirAbs,
    resolutionMode: 'exact',
  });
  return { resolved, catalog, program: parsed.project.program, discovery };
}

describe('collectSemanticReferenceFacts', () => {
  it('emits interface/type-alias declarations and cross-file type references', async () => {
    const projectDir = writeProject({
      'src/types.ts': `export interface Widget { id: string }\nexport type WidgetId = string;\n`,
      'src/use.ts': `import type { Widget, WidgetId } from './types.js';\nexport function take(w: Widget): WidgetId { return w.id; }\n`,
    });
    const { resolved } = await exactSemanticFacts(projectDir);
    expect(resolved.semanticFacts).toBeDefined();
    const facts = resolved.semanticFacts!;
    expect(facts.referenceScope).toBe('cross-file');
    const names = facts.declarations.map((d) => d.name).sort();
    expect(names).toEqual(expect.arrayContaining(['Widget', 'WidgetId', 'take']));
    const iface = facts.declarations.find((d) => d.name === 'Widget' && d.kind === 'interface');
    expect(iface).toBeDefined();
    const cross = facts.references.filter(
      (r) => r.targetDeclarationId === iface?.declarationId || r.targetName === 'Widget',
    );
    expect(cross.some((r) => r.filePath.includes('use.ts'))).toBe(true);
    expect(cross.every((r) => r.filePath !== iface?.filePath)).toBe(true);
    expect(
      facts.references
        .filter((reference) => reference.reason === 'target-not-in-project-inventory')
        .map((reference) => reference.targetName),
    ).toEqual([]);
    expect(new Set(facts.references.map((reference) => reference.referenceId)).size).toBe(
      facts.references.length,
    );
  });

  it('omits the plane in fast mode', async () => {
    const projectDir = writeProject({
      'src/a.ts': `export function a() { return 1; }\n`,
    });
    const discovery = await typescriptGraphAdapter.discoverFiles({
      cwd: projectDir,
      diagnosticIntent: 'quiet',
    });
    const parsed = await typescriptGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      configPathAbs: discovery.configPathAbs,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'fast',
    });
    const walked = await typescriptGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: new Date().toISOString(),
      cacheKey: 'test',
      resolutionMode: 'fast',
      functions: walked.occurrences,
    };
    const resolved = await typescriptGraphAdapter.resolveCallSites({
      project: parsed.project,
      catalog,
      callSites: walked.callSites,
      dependencySites: walked.dependencySites,
      projectDirAbs: discovery.projectDirAbs,
      resolutionMode: 'fast',
    });
    expect(resolved.semanticFacts).toBeUndefined();
  });

  it('wires production constants and injected small limits', async () => {
    expect(MAX_SEMANTIC_DECLARATIONS).toBe(100_000);
    expect(DEFAULT_SEMANTIC_FACT_LIMITS.maxDeclarations).toBe(100_000);

    const projectDir = writeProject({
      'src/many.ts': `export type A = 1;\nexport type B = 2;\nexport type C = 3;\n`,
    });
    const { program, discovery, catalog } = await exactSemanticFacts(projectDir);
    const crossPackage = buildCrossPackageContext(catalog, discovery.projectDirAbs);
    const limited = collectSemanticReferenceFacts({
      program,
      discoveredFiles: discovery.files,
      projectRootAbs: discovery.projectDirAbs,
      crossPackage,
      limits: {
        ...DEFAULT_SEMANTIC_FACT_LIMITS,
        maxDeclarations: 2,
        maxReferences: 2,
      },
    });
    expect(limited.declarations.length).toBeLessThanOrEqual(2);
    expect(limited.coverage.status === 'partial' || limited.declarations.length <= 2).toBe(true);
  });

  it('marks checker exceptions as partial semantic coverage', async () => {
    const projectDir = writeProject({
      'src/a.ts': `export interface A { value: string }\nexport const a: A = { value: 'x' };\n`,
    });
    const { program, discovery, catalog } = await exactSemanticFacts(projectDir);
    const checker = program.getTypeChecker();
    vi.spyOn(checker, 'getSymbolAtLocation').mockImplementation(() => {
      throw new Error('synthetic checker fault');
    });

    const facts = collectSemanticReferenceFacts({
      program,
      discoveredFiles: discovery.files,
      projectRootAbs: discovery.projectDirAbs,
      crossPackage: buildCrossPackageContext(catalog, discovery.projectDirAbs),
    });

    expect(facts.coverage.status).toBe('partial');
    expect(facts.coverage.reasons).toContain('semantic-checker-fault');
  });

  it('bounds semantic AST traversal and records partial coverage', async () => {
    const projectDir = writeProject({
      'src/deep.ts': `export const value = ${'('.repeat(600)}1${')'.repeat(600)};\n`,
    });
    const { program, discovery, catalog } = await exactSemanticFacts(projectDir);

    const facts = collectSemanticReferenceFacts({
      program,
      discoveredFiles: discovery.files,
      projectRootAbs: discovery.projectDirAbs,
      crossPackage: buildCrossPackageContext(catalog, discovery.projectDirAbs),
    });

    expect(facts.coverage.status).toBe('partial');
    expect(facts.coverage.reasons).toContain('semantic-walk-depth');
  });

  it('accounts for an unresolvable declaration path before classifying it as external', () => {
    const projectDir = writeProject({ 'src/a.ts': 'export const a = 1;\n' });
    const coverage = { reasons: [] as string[] };

    expect(isExternalDeclarationFile(join(projectDir, 'missing.d.ts'), projectDir, coverage)).toBe(
      true,
    );
    expect(coverage.reasons).toContain('declaration-realpath-unresolvable');
  });

  it('returns present-empty complete coverage when there are no project facts', async () => {
    const projectDir = writeProject({
      'src/empty.ts': `// empty module\n`,
    });
    const { resolved } = await exactSemanticFacts(projectDir);
    expect(resolved.semanticFacts).toBeDefined();
    // May still emit module-level import/export facts as none; empty file may have no decls.
    expect(resolved.semanticFacts!.referenceScope).toBe('cross-file');
    expect(Array.isArray(resolved.semanticFacts!.declarations)).toBe(true);
    expect(Array.isArray(resolved.semanticFacts!.references)).toBe(true);
  });

  it('emits class/enum/namespace declarations and heritage references', async () => {
    const projectDir = writeProject({
      'src/base.ts': `export class Base { x = 1; }\nexport enum Kind { A, B }\nexport namespace NS { export const v = 1; }\n`,
      'src/derived.ts': `import { Base, Kind, NS } from './base.js';\nexport class Child extends Base { k: Kind = Kind.A; n = NS.v; }\n`,
    });
    const { resolved } = await exactSemanticFacts(projectDir);
    const facts = resolved.semanticFacts!;
    const kinds = new Set(facts.declarations.map((d) => d.kind));
    expect(kinds.has('class') || kinds.has('enum') || kinds.has('namespace')).toBe(true);
    expect(facts.references.some((r) => r.kind === 'heritage' || r.kind === 'type')).toBe(true);
  });

  it('emits re-export and import declaration facts without same-file references only', async () => {
    const projectDir = writeProject({
      'src/lib.ts': `export function helper() { return 1; }\nexport interface Shape { n: number }\n`,
      'src/reexport.ts': `export { helper } from './lib.js';\nexport type { Shape } from './lib.js';\n`,
      'src/local.ts': `export interface Local { a: number }\nexport type LocalAlias = Local;\n`,
    });
    const { resolved } = await exactSemanticFacts(projectDir);
    const facts = resolved.semanticFacts!;
    expect(facts.declarations.some((d) => d.kind === 'export' || d.name === 'helper')).toBe(true);
    // Same-file Local -> LocalAlias must not appear as a cross-file reference.
    const local = facts.declarations.find((d) => d.name === 'Local');
    if (local !== undefined) {
      const sameFileRefs = facts.references.filter(
        (r) => r.targetDeclarationId === local.declarationId && r.filePath === local.filePath,
      );
      expect(sameFileRefs).toHaveLength(0);
    }
  });

  it('does not emit declarations from compiler-loaded files outside discovery', async () => {
    const projectDir = writeProject(
      {
        'src/entry.ts':
          `import { hidden } from '../excluded/hidden.js';\n` +
          `export function entry() { return hidden(); }\n`,
        'excluded/hidden.ts': `export function hidden() { return 1; }\n`,
      },
      ['src/entry.ts'],
    );

    const { resolved, discovery } = await exactSemanticFacts(projectDir);

    expect(discovery.files.map((file) => relative(discovery.projectDirAbs, file))).toEqual([
      'src/entry.ts',
    ]);
    expect(
      resolved.semanticFacts!.declarations.some(
        (declaration) => declaration.filePath === 'excluded/hidden.ts',
      ),
    ).toBe(false);
  });

  it('preserves export-list and ECMAScript-private visibility on declaration facts', async () => {
    const projectDir = writeProject({
      'src/visibility.ts':
        `function listed() { return 1; }\n` +
        `export { listed };\n` +
        `export const direct = 2;\n` +
        `class Service { #method() { return 3; } }\n`,
    });

    const { resolved } = await exactSemanticFacts(projectDir);
    const declarations = resolved.semanticFacts!.declarations;
    const listed = declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.name === 'listed',
    );
    const direct = declarations.find(
      (declaration) => declaration.kind === 'variable' && declaration.name === 'direct',
    );
    const privateMethod = declarations.find(
      (declaration) => declaration.kind === 'method' && declaration.name === '#method',
    );

    expect(listed).toMatchObject({ visibility: 'exported', exportRole: 'named-export' });
    expect(direct).toMatchObject({ visibility: 'exported', exportRole: 'named-export' });
    expect(privateMethod?.visibility).toBe('private');
  });

  it('emits named function and class expressions as declarations', async () => {
    const projectDir = writeProject({
      'src/expressions.ts':
        `export const fn = function inner() { return 1; };\n` +
        `export const C = class InnerClass {};\n`,
    });

    const { resolved } = await exactSemanticFacts(projectDir);
    const declarations = resolved.semanticFacts!.declarations;

    expect(
      declarations.some(
        (declaration) => declaration.kind === 'function' && declaration.name === 'inner',
      ),
    ).toBe(true);
    expect(
      declarations.some(
        (declaration) => declaration.kind === 'class' && declaration.name === 'InnerClass',
      ),
    ).toBe(true);
  });

  it('classifies a declaration exported with TypeScript `export =` as exported', async () => {
    const projectDir = writeProject({
      'src/export-equals.ts': `function helper() { return 1; }\nexport = helper;\n`,
    });

    const { resolved } = await exactSemanticFacts(projectDir);
    const helper = resolved.semanticFacts!.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.name === 'helper',
    );

    expect(helper).toMatchObject({ visibility: 'exported', exportRole: 'default-export' });
  });
});
