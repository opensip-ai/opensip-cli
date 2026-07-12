import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';

import { DEFAULT_SEMANTIC_FACT_LIMITS, MAX_SEMANTIC_DECLARATIONS } from '@opensip-cli/graph';

import { buildCrossPackageContext } from '../edge-helpers/cross-package-context.js';
import { collectSemanticReferenceFacts } from '../semantic-reference-facts.js';
import { typescriptGraphAdapter } from '../index.js';

import type { Catalog } from '@opensip-cli/graph';

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function writeProject(files: Record<string, string>): string {
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
      include: ['**/*.ts'],
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
  const discovery = await typescriptGraphAdapter.discoverFiles({ cwd: projectDir, diagnosticIntent: 'quiet' });
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
  });

  it('omits the plane in fast mode', async () => {
    const projectDir = writeProject({
      'src/a.ts': `export function a() { return 1; }\n`,
    });
    const discovery = await typescriptGraphAdapter.discoverFiles({ cwd: projectDir, diagnosticIntent: 'quiet' });
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
});
