import { describe, it, expect } from 'vitest';

import { packageOf, resolveCallee, callerImportedPackages } from '../resolve-callee.js';

import type { FunctionOccurrence, Indexes } from '../types.js';

function occ(
  over: Partial<FunctionOccurrence> & { bodyHash: string; filePath: string; qualifiedName: string },
): FunctionOccurrence {
  return {
    bodySize: 50,
    simpleName: 'f',
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

function indexesOf(
  occs: readonly FunctionOccurrence[],
  importedPackagesByFile: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): Indexes {
  const occurrencesByHash = new Map<string, FunctionOccurrence[]>();
  const byBodyHash = new Map<string, FunctionOccurrence>();
  for (const o of occs) {
    byBodyHash.set(o.bodyHash, o);
    const bucket = occurrencesByHash.get(o.bodyHash) ?? [];
    bucket.push(o);
    occurrencesByHash.set(o.bodyHash, bucket);
  }
  return {
    byBodyHash,
    byOccId: new Map(),
    occurrencesByHash,
    importedPackagesByFile,
    bySimpleName: new Map(),
    callees: new Map(),
    callers: new Map(),
  };
}

describe('packageOf', () => {
  it('returns the first segment under packages/', () => {
    expect(packageOf('packages/core/src/x.ts')).toBe('core');
    expect(packageOf('packages/languages/lang-typescript/src/x.ts')).toBe('languages');
    expect(packageOf('packages/graph/graph-typescript/src/x.ts')).toBe('graph');
  });
  it('returns <unknown> for non-packages paths', () => {
    expect(packageOf('src/x.ts')).toBe('<unknown>');
    expect(packageOf('')).toBe('<unknown>');
  });
});

describe('resolveCallee', () => {
  // Identical body 'H' in two packages: pkg-a and pkg-b.
  const aF = occ({
    bodyHash: 'H',
    filePath: 'packages/pkg-a/src/f.ts',
    qualifiedName: 'packages/pkg-a/src/f.f',
  });
  const bF = occ({
    bodyHash: 'H',
    filePath: 'packages/pkg-b/src/f.ts',
    qualifiedName: 'packages/pkg-b/src/f.f',
  });
  const bG = occ({
    bodyHash: 'G',
    filePath: 'packages/pkg-b/src/g.ts',
    qualifiedName: 'packages/pkg-b/src/g.g',
    simpleName: 'g',
  });

  it('returns undefined when the hash has no occurrences', () => {
    expect(resolveCallee('NOPE', aF, indexesOf([aF, bF]))).toBeUndefined();
  });

  it('returns the only candidate when the hash is unique', () => {
    expect(resolveCallee('G', aF, indexesOf([aF, bG]))).toBe(bG);
  });

  it('prefers the caller’s own package on a cross-package body collision', () => {
    const caller = occ({
      bodyHash: 'C',
      filePath: 'packages/pkg-a/src/call.ts',
      qualifiedName: 'packages/pkg-a/src/call.caller',
      simpleName: 'caller',
    });
    expect(resolveCallee('H', caller, indexesOf([aF, bF, caller]))).toBe(aF);
  });

  it('falls back to an imported package when no same-package candidate exists', () => {
    const caller = occ({
      bodyHash: 'C',
      filePath: 'packages/pkg-c/src/call.ts',
      qualifiedName: 'packages/pkg-c/src/call.caller',
      simpleName: 'caller',
    });
    const imports = new Map([['packages/pkg-c/src/call.ts', new Set(['pkg-b'])]]);
    expect(resolveCallee('H', caller, indexesOf([aF, bF, caller], imports))).toBe(bF);
  });

  it('falls back to the lowest qualifiedName when neither same-package nor imported matches', () => {
    const caller = occ({
      bodyHash: 'C',
      filePath: 'packages/pkg-z/src/call.ts',
      qualifiedName: 'packages/pkg-z/src/call.caller',
      simpleName: 'caller',
    });
    // pkg-a sorts before pkg-b by qualifiedName → deterministic.
    expect(resolveCallee('H', caller, indexesOf([bF, aF, caller]))).toBe(aF);
  });
});

describe('callerImportedPackages', () => {
  it('reads the import set for the caller’s file, empty when absent (fast mode)', () => {
    const caller = occ({
      bodyHash: 'C',
      filePath: 'packages/pkg-a/src/x.ts',
      qualifiedName: 'packages/pkg-a/src/x.c',
      simpleName: 'c',
    });
    const withImports = indexesOf(
      [caller],
      new Map([['packages/pkg-a/src/x.ts', new Set(['core'])]]),
    );
    expect([...callerImportedPackages(caller, withImports)]).toEqual(['core']);
    expect(callerImportedPackages(caller, indexesOf([caller])).size).toBe(0);
  });
});
