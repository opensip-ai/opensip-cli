import { describe, it, expect } from 'vitest';

import { constrainCrossPackageEdges } from '../constrain-edges.js';

import type { CallEdge, Catalog, FunctionOccurrence, ResolutionMode } from '../../types.js';

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

function edge(over: Partial<CallEdge> & { to: string[] }): CallEdge {
  return { line: 1, column: 0, resolution: 'unknown', confidence: 'medium', text: 'f()', ...over };
}

/** module-init occurrence in `filePath` importing each specifier. */
function moduleInit(filePath: string, specifiers: string[]): FunctionOccurrence {
  return {
    ...occ({ bodyHash: `MI:${filePath}`, filePath, simpleName: '<module-init>' }),
    kind: 'module-init',
    dependencies: specifiers.map((specifier) => ({ to: [], specifier, line: 1, column: 0 })),
  };
}

function catalogOf(
  functions: Record<string, FunctionOccurrence[]>,
  resolutionMode: ResolutionMode = 'exact',
): Catalog {
  return { version: '3.0', tool: 'graph', language: 'typescript', builtAt: 'x', cacheKey: 'k', functions, resolutionMode };
}

const A = 'packages/pkg-a/src/call.ts';
// Authoritative name→group map (mirrors what buildPackageGroupMap reads from disk).
const PKG_MAP = new Map<string, string>([
  ['@scope/pkga', 'pkg-a'],
  ['@scope/pkgb', 'pkg-b'],
  ['@scope/pkgc', 'pkg-c'],
]);

describe('constrainCrossPackageEdges', () => {
  it('drops a name-guessed edge into a package the caller does not import', () => {
    const target = occ({ bodyHash: 'H', filePath: 'packages/pkg-b/src/f.ts' });
    const caller = occ({ bodyHash: 'C', filePath: A, simpleName: 'caller', calls: [edge({ to: ['H'] })] });
    const out = constrainCrossPackageEdges(catalogOf({ f: [target], caller: [caller] }), PKG_MAP);
    expect(out.functions.caller[0].calls[0].to).toEqual([]);
  });

  it('keeps a name-guessed edge into a package the caller imports (by specifier)', () => {
    const target = occ({ bodyHash: 'H', filePath: 'packages/pkg-b/src/f.ts' });
    const caller = occ({ bodyHash: 'C', filePath: A, simpleName: 'caller', calls: [edge({ to: ['H'] })] });
    const mi = moduleInit(A, ['@scope/pkgb']); // pkg-a's module imports pkg-b
    const out = constrainCrossPackageEdges(
      catalogOf({ f: [target], caller: [caller], '<module-init>': [mi] }),
      PKG_MAP,
    );
    expect(out.functions.caller[0].calls[0].to).toEqual(['H']);
  });

  it('keeps a same-package name-guessed edge', () => {
    const target = occ({ bodyHash: 'H', filePath: 'packages/pkg-a/src/f.ts' });
    const caller = occ({ bodyHash: 'C', filePath: A, simpleName: 'caller', calls: [edge({ to: ['H'] })] });
    const out = constrainCrossPackageEdges(catalogOf({ f: [target], caller: [caller] }), PKG_MAP);
    expect(out.functions.caller[0].calls[0].to).toEqual(['H']);
  });

  it('never drops a type-checker-backed (static) edge, even cross-package', () => {
    const target = occ({ bodyHash: 'H', filePath: 'packages/pkg-b/src/f.ts' });
    const caller = occ({ bodyHash: 'C', filePath: A, simpleName: 'caller', calls: [edge({ to: ['H'], resolution: 'static', confidence: 'high' })] });
    const out = constrainCrossPackageEdges(catalogOf({ f: [target], caller: [caller] }), PKG_MAP);
    expect(out.functions.caller[0].calls[0].to).toEqual(['H']);
    expect(out.functions.caller[0]).toBe(caller); // unchanged ⇒ same reference
  });

  it('keeps a colliding hash when any occurrence is in a reachable package', () => {
    const aF = occ({ bodyHash: 'H', filePath: 'packages/pkg-a/src/f.ts', qualifiedName: 'a.f' });
    const bF = occ({ bodyHash: 'H', filePath: 'packages/pkg-b/src/f.ts', qualifiedName: 'b.f' });
    const caller = occ({ bodyHash: 'C', filePath: A, simpleName: 'caller', calls: [edge({ to: ['H'] })] });
    const out = constrainCrossPackageEdges(catalogOf({ f: [aF, bF], caller: [caller] }), PKG_MAP);
    expect(out.functions.caller[0].calls[0].to).toEqual(['H']); // pkg-a candidate keeps it
  });

  it('drops only the unreachable targets of a multi-target edge', () => {
    const bF = occ({ bodyHash: 'Hb', filePath: 'packages/pkg-b/src/f.ts', qualifiedName: 'b.f' });
    const cF = occ({ bodyHash: 'Hc', filePath: 'packages/pkg-c/src/f.ts', qualifiedName: 'c.f' });
    const caller = occ({ bodyHash: 'C', filePath: A, simpleName: 'caller', calls: [edge({ to: ['Hb', 'Hc'] })] });
    const mi = moduleInit(A, ['@scope/pkgc']); // imports pkg-c only
    const out = constrainCrossPackageEdges(
      catalogOf({ f: [bF, cF], caller: [caller], '<module-init>': [mi] }),
      PKG_MAP,
    );
    expect(out.functions.caller[0].calls[0].to).toEqual(['Hc']); // pkg-b dropped, pkg-c (imported) kept
  });

  it('ignores relative and external specifiers, unions multiple workspace imports', () => {
    const bF = occ({ bodyHash: 'Hb', filePath: 'packages/pkg-b/src/f.ts', qualifiedName: 'b.f' });
    const cF = occ({ bodyHash: 'Hc', filePath: 'packages/pkg-c/src/f.ts', qualifiedName: 'c.f' });
    const callB = occ({ bodyHash: 'CB', filePath: A, simpleName: 'callB', calls: [edge({ to: ['Hb'] })] });
    const callC = occ({ bodyHash: 'CC', filePath: A, simpleName: 'callC', calls: [edge({ to: ['Hc'] })] });
    // Relative + external (non-workspace, no leading @) specifiers must be ignored;
    // both workspace imports unioned onto the one file.
    const mi = moduleInit(A, ['./local', 'lodash/fp', '@scope/pkgb', '@scope/pkgc']);
    const out = constrainCrossPackageEdges(
      catalogOf({ f: [bF, cF], callB: [callB], callC: [callC], '<module-init>': [mi] }),
      PKG_MAP,
    );
    expect(out.functions.callB[0].calls[0].to).toEqual(['Hb']); // pkg-b imported ⇒ kept
    expect(out.functions.callC[0].calls[0].to).toEqual(['Hc']); // pkg-c imported ⇒ kept
  });

  it('drops a name-guessed edge into another package’s test file (builtin .map/.find collision)', () => {
    // Imported package, but the only candidate is a TEST-file arrow named `map`
    // (a builtin Array.map name-guessed across the boundary) — not importable.
    const testArrow = occ({ bodyHash: 'H', filePath: 'packages/pkg-b/src/__tests__/x.test.ts', simpleName: 'map', inTestFile: true });
    const caller = occ({ bodyHash: 'C', filePath: A, simpleName: 'caller', calls: [edge({ to: ['H'], text: 'xs.map(...)' })] });
    const mi = moduleInit(A, ['@scope/pkgb']); // pkg-a DOES import pkg-b
    const out = constrainCrossPackageEdges(
      catalogOf({ f: [testArrow], caller: [caller], '<module-init>': [mi] }),
      PKG_MAP,
    );
    expect(out.functions.caller[0].calls[0].to).toEqual([]); // cross-package test callee dropped
  });

  it('keeps a same-package test-file callee (test calling its own package’s test helper)', () => {
    const testHelper = occ({ bodyHash: 'H', filePath: 'packages/pkg-a/src/__tests__/helper.test.ts', inTestFile: true });
    const caller = occ({ bodyHash: 'C', filePath: 'packages/pkg-a/src/__tests__/x.test.ts', simpleName: 'caller', inTestFile: true, calls: [edge({ to: ['H'] })] });
    const out = constrainCrossPackageEdges(catalogOf({ f: [testHelper], caller: [caller] }), PKG_MAP);
    expect(out.functions.caller[0].calls[0].to).toEqual(['H']); // same package ⇒ kept
  });

  it('returns the catalog untouched in fast mode (no import set)', () => {
    const target = occ({ bodyHash: 'H', filePath: 'packages/pkg-b/src/f.ts' });
    const caller = occ({ bodyHash: 'C', filePath: A, simpleName: 'caller', calls: [edge({ to: ['H'] })] });
    const input = catalogOf({ f: [target], caller: [caller] }, 'fast');
    expect(constrainCrossPackageEdges(input, PKG_MAP)).toBe(input);
  });

  it('returns the catalog untouched when the package map is empty (non-monorepo)', () => {
    const target = occ({ bodyHash: 'H', filePath: 'packages/pkg-b/src/f.ts' });
    const caller = occ({ bodyHash: 'C', filePath: A, simpleName: 'caller', calls: [edge({ to: ['H'] })] });
    const input = catalogOf({ f: [target], caller: [caller] });
    expect(constrainCrossPackageEdges(input, new Map())).toBe(input);
  });
});
