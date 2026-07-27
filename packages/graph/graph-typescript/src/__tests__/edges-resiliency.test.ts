import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCrossPackageContext } from '../edge-helpers/cross-package-context.js';
import { resolveEdgesFromRecords, resolveEdgesSyntactic } from '../edges.js';
import { walkProgram } from '../walk.js';

import type { Catalog } from '@opensip-cli/graph';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'graph-ts-edge-resiliency-'));
  roots.push(root);
  const fileName = join(root, 'fixture.ts');
  writeFileSync(
    fileName,
    'export function target(): number { return 1; }\nexport function caller(): number { return target(); }\n',
  );
  const program = ts.createProgram({ rootNames: [fileName], options: { strict: true } });
  const walked = walkProgram({
    sourceFiles: program.getSourceFiles(),
    files: [fileName],
    projectDirAbs: root,
  });
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-26T00:00:00.000Z',
    cacheKey: 'fixture',
    functions: walked.functions,
  };
  return { root, program, walked, catalog };
}

describe('TypeScript edge resolution resiliency', () => {
  it('contains checker faults per exact call site and returns registered degradation', async () => {
    const { root, program, walked, catalog } = fixture();
    vi.spyOn(program.getTypeChecker(), 'getSymbolAtLocation').mockImplementation(() => {
      throw new Error('synthetic checker fault');
    });

    const result = await resolveEdgesFromRecords({
      catalog,
      program,
      projectDirAbs: root,
      callSites: walked.callSites,
      crossPackage: buildCrossPackageContext(catalog, root),
    });

    expect(result.degradations).toEqual([
      {
        errorCode: 'GRAPH.ANALYSIS.SEMANTIC_RESOLUTION_DEGRADED',
        condition: 'typescript-exact-resolution',
        count: 1,
      },
    ]);
    expect(result.resolutionStats.unresolved).toBeGreaterThanOrEqual(1);
  });

  it('contains syntactic site projection faults and returns registered degradation', async () => {
    const { root, walked, catalog } = fixture();
    const call = walked.callSites.find((site) => site.kind === 'call');
    expect(call).toBeDefined();
    if (call === undefined) return;
    vi.spyOn(call.node, 'getStart').mockImplementation(() => {
      throw new Error('synthetic source-position fault');
    });

    const result = await resolveEdgesSyntactic({
      catalog,
      projectDirAbs: root,
      callSites: walked.callSites,
    });

    expect(result.degradations).toEqual([
      {
        errorCode: 'GRAPH.ANALYSIS.SEMANTIC_RESOLUTION_DEGRADED',
        condition: 'typescript-syntactic-resolution',
        count: 1,
      },
    ]);
  });
});
