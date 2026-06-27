import { describe, it, expect } from 'vitest';

import { buildIndexes } from '../indexes.js';

import type { Catalog, FunctionOccurrence } from '../../types.js';

function occ(
  over: Partial<FunctionOccurrence> & { bodyHash: string; filePath: string },
): FunctionOccurrence {
  return {
    simpleName: 'f',
    qualifiedName: `${over.filePath}.f`,
    line: 1,
    column: 0,
    endLine: 2,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...over,
  };
}

function catalogOf(functions: Record<string, FunctionOccurrence[]>): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'k',
    functions,
  };
}

function call(to: string): NonNullable<FunctionOccurrence['calls']>[number] {
  return {
    to: [to],
    line: 1,
    column: 0,
    resolution: 'static',
    confidence: 'high',
    text: 'f()',
  };
}

describe('buildIndexes — occurrencesByHash + importedPackagesByFile', () => {
  it('groups all occurrences per body hash (no collapse)', () => {
    const a = occ({ bodyHash: 'H', filePath: 'packages/pkg-a/src/f.ts' });
    const b = occ({ bodyHash: 'H', filePath: 'packages/pkg-b/src/f.ts' });
    const idx = buildIndexes(catalogOf({ f: [a, b] }));
    expect(idx.occurrencesByHash.get('H')).toHaveLength(2);
    expect(idx.byBodyHash.get('H')).toBeDefined(); // still one (content-dedup)
  });

  it('derives imported packages from module-init dependencies', () => {
    const callerMi: FunctionOccurrence = {
      ...occ({
        bodyHash: 'MI_A',
        filePath: 'packages/pkg-a/src/index.ts',
        simpleName: '<module-init>',
      }),
      kind: 'module-init',
      dependencies: [{ to: ['MI_B'], specifier: '@scope/pkgb', line: 1, column: 0 }],
    };
    const targetMi = occ({
      bodyHash: 'MI_B',
      filePath: 'packages/pkg-b/src/index.ts',
      simpleName: '<module-init>',
    });
    const idx = buildIndexes(catalogOf({ '<module-init>': [callerMi, targetMi] }));
    expect([...(idx.importedPackagesByFile.get('packages/pkg-a/src/index.ts') ?? [])]).toEqual([
      'pkg-b',
    ]);
    // a file with no resolved imports gets no entry
    expect(idx.importedPackagesByFile.has('packages/pkg-b/src/index.ts')).toBe(false);
  });

  it('unions call-edge adjacency across body-twins (ADR-0003 reachability)', () => {
    // Same body hash H in two files, each calling a DIFFERENT in-catalog target.
    const twinA = occ({
      bodyHash: 'H',
      filePath: 'packages/a/src/x.ts',
      simpleName: 'twin',
      calls: [call('TA')],
    });
    const twinB = occ({
      bodyHash: 'H',
      filePath: 'packages/b/src/x.ts',
      simpleName: 'twin',
      calls: [call('TB')],
    });
    const ta = occ({
      bodyHash: 'TA',
      filePath: 'packages/a/src/y.ts',
      simpleName: 'ta',
    });
    const tb = occ({
      bodyHash: 'TB',
      filePath: 'packages/b/src/y.ts',
      simpleName: 'tb',
    });
    const idx = buildIndexes(catalogOf({ twin: [twinA, twinB], ta: [ta], tb: [tb] }));
    // callees['H'] is the UNION of both twins' out-edges, not the byBodyHash winner's only.
    expect([...(idx.callees.get('H') ?? [])].sort()).toEqual(['TA', 'TB']);
    expect(idx.callers.get('TA')).toContain('H');
    expect(idx.callers.get('TB')).toContain('H');
  });

  it('unions imports when a file has multiple dependency targets', () => {
    const callerMi: FunctionOccurrence = {
      ...occ({
        bodyHash: 'MI_A',
        filePath: 'packages/pkg-a/src/index.ts',
        simpleName: '<module-init>',
      }),
      kind: 'module-init',
      dependencies: [
        { to: ['MI_B'], specifier: '@scope/pkgb', line: 1, column: 0 },
        { to: ['MI_C'], specifier: '@scope/pkgc', line: 2, column: 0 },
      ],
    };
    const miB = occ({
      bodyHash: 'MI_B',
      filePath: 'packages/pkg-b/src/index.ts',
      simpleName: '<module-init>',
    });
    const miC = occ({
      bodyHash: 'MI_C',
      filePath: 'packages/pkg-c/src/index.ts',
      simpleName: '<module-init>',
    });
    const idx = buildIndexes(catalogOf({ '<module-init>': [callerMi, miB, miC] }));
    expect(
      [...(idx.importedPackagesByFile.get('packages/pkg-a/src/index.ts') ?? [])].sort(),
    ).toEqual(['pkg-b', 'pkg-c']);
  });
});
