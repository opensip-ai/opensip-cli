/**
 * Linker data structures (Phase 1): per-package export symbol index.
 *
 * The export index buckets `visibility === 'exported'` occurrences by
 * `packageOf(filePath)` then by `simpleName` — the candidate table the Phase-2
 * boundary resolver links a bare-specifier callee against.
 */

import { describe, expect, it } from 'vitest';

import { buildExportIndex } from '../export-index.js';

import type { Catalog, FunctionOccurrence, Visibility } from '../../../types.js';

function occ(
  simpleName: string,
  filePath: string,
  bodyHash: string,
  visibility: Visibility = 'exported',
): FunctionOccurrence {
  return {
    bodyHash,
    simpleName,
    qualifiedName: `${filePath}.${simpleName}`,
    filePath,
    line: 1,
    column: 0,
    endLine: 1,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility,
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
  };
}

function catalog(...occs: FunctionOccurrence[]): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const o of occs) {
    const bucket = functions[o.simpleName];
    if (bucket) bucket.push(o);
    else functions[o.simpleName] = [o];
  }
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'k',
    resolutionMode: 'exact',
    functions,
  };
}

describe('buildExportIndex', () => {
  it('includes exported occurrences and excludes module-local / private', () => {
    const cat = catalog(
      occ('shown', 'packages/core/src/a.ts', 'A', 'exported'),
      occ('localOnly', 'packages/core/src/a.ts', 'B', 'module-local'),
      occ('privateOnly', 'packages/core/src/a.ts', 'C', 'private'),
    );
    const index = buildExportIndex(cat);
    const core = index.get('core');
    expect(core).toBeDefined();
    expect([...(core?.keys() ?? [])]).toEqual(['shown']);
    expect(core?.get('shown')?.map((o) => o.bodyHash)).toEqual(['A']);
    expect(core?.get('localOnly')).toBeUndefined();
    expect(core?.get('privateOnly')).toBeUndefined();
  });

  it('buckets exported occurrences by package group then name across packages', () => {
    const cat = catalog(
      occ('build', 'packages/core/src/a.ts', 'A'),
      occ('build', 'packages/graph/engine/src/b.ts', 'B'),
      occ('run', 'packages/graph/engine/src/c.ts', 'C'),
    );
    const index = buildExportIndex(cat);
    expect([...index.keys()].sort()).toEqual(['core', 'graph']);
    expect(index.get('core')?.get('build')?.map((o) => o.bodyHash)).toEqual(['A']);
    expect(index.get('graph')?.get('build')?.map((o) => o.bodyHash)).toEqual(['B']);
    expect(index.get('graph')?.get('run')?.map((o) => o.bodyHash)).toEqual(['C']);
  });

  it('collects multiple exported occurrences of one name in a package', () => {
    const cat = catalog(
      occ('overload', 'packages/core/src/a.ts', 'A'),
      occ('overload', 'packages/core/src/b.ts', 'B'),
    );
    const index = buildExportIndex(cat);
    expect(index.get('core')?.get('overload')?.map((o) => o.bodyHash).sort()).toEqual(['A', 'B']);
  });

  it('keeps same-named exports in different packages separate (name collision)', () => {
    const cat = catalog(
      occ('serialize', 'packages/core/src/a.ts', 'A'),
      occ('serialize', 'packages/output/src/b.ts', 'B'),
    );
    const index = buildExportIndex(cat);
    expect(index.get('core')?.get('serialize')?.map((o) => o.bodyHash)).toEqual(['A']);
    expect(index.get('output')?.get('serialize')?.map((o) => o.bodyHash)).toEqual(['B']);
  });
});
