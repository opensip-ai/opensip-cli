import { describe, it, expect } from 'vitest';

import { constrainCrossPackageEdges } from '../constrain-edges.js';

import type { CallEdge, Catalog, FunctionOccurrence, ResolutionMode } from '../../types.js';

function occ(
  over: Partial<FunctionOccurrence> & { bodyHash: string; filePath: string; package: string },
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

/** module-init occurrence in `filePath` (package `pkg`) importing each specifier. */
function moduleInit(filePath: string, pkg: string, specifiers: string[]): FunctionOccurrence {
  return {
    ...occ({ bodyHash: `MI:${filePath}`, filePath, package: pkg, simpleName: '<module-init>' }),
    kind: 'module-init',
    dependencies: specifiers.map((specifier) => ({ to: [], specifier, line: 1, column: 0 })),
  };
}

function catalogOf(
  functions: Record<string, FunctionOccurrence[]>,
  resolutionMode: ResolutionMode = 'exact',
): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'k',
    functions,
    resolutionMode,
  };
}

const A = 'packages/pkg-a/src/call.ts';
const PKGA = '@scope/pkga';
const PKGB = '@scope/pkgb';
const PKGC = '@scope/pkgc';

describe('constrainCrossPackageEdges', () => {
  it('drops a name-guessed edge into a package the caller does not import', () => {
    const target = occ({ bodyHash: 'H', filePath: 'packages/pkg-b/src/f.ts', package: PKGB });
    const caller = occ({
      bodyHash: 'C',
      filePath: A,
      package: PKGA,
      simpleName: 'caller',
      calls: [edge({ to: ['H'] })],
    });
    const out = constrainCrossPackageEdges(catalogOf({ f: [target], caller: [caller] }));
    expect(out.functions.caller[0].calls[0].to).toEqual([]);
  });

  it('keeps a name-guessed edge into a package the caller imports (by specifier)', () => {
    const target = occ({ bodyHash: 'H', filePath: 'packages/pkg-b/src/f.ts', package: PKGB });
    const caller = occ({
      bodyHash: 'C',
      filePath: A,
      package: PKGA,
      simpleName: 'caller',
      calls: [edge({ to: ['H'] })],
    });
    const mi = moduleInit(A, PKGA, [PKGB]); // pkg-a's module imports pkg-b
    const out = constrainCrossPackageEdges(
      catalogOf({ f: [target], caller: [caller], '<module-init>': [mi] }),
    );
    expect(out.functions.caller[0].calls[0].to).toEqual(['H']);
  });

  it('keeps a same-package name-guessed edge', () => {
    const target = occ({ bodyHash: 'H', filePath: 'packages/pkg-a/src/f.ts', package: PKGA });
    const caller = occ({
      bodyHash: 'C',
      filePath: A,
      package: PKGA,
      simpleName: 'caller',
      calls: [edge({ to: ['H'] })],
    });
    const out = constrainCrossPackageEdges(catalogOf({ f: [target], caller: [caller] }));
    expect(out.functions.caller[0].calls[0].to).toEqual(['H']);
  });

  it('never drops a type-checker-backed (static) edge, even cross-package', () => {
    const target = occ({ bodyHash: 'H', filePath: 'packages/pkg-b/src/f.ts', package: PKGB });
    const caller = occ({
      bodyHash: 'C',
      filePath: A,
      package: PKGA,
      simpleName: 'caller',
      calls: [edge({ to: ['H'], resolution: 'static', confidence: 'high' })],
    });
    const out = constrainCrossPackageEdges(catalogOf({ f: [target], caller: [caller] }));
    expect(out.functions.caller[0].calls[0].to).toEqual(['H']);
    expect(out.functions.caller[0]).toBe(caller); // unchanged ⇒ same reference
  });

  it('keeps a colliding hash when any occurrence is in a reachable package', () => {
    const aF = occ({
      bodyHash: 'H',
      filePath: 'packages/pkg-a/src/f.ts',
      package: PKGA,
      qualifiedName: 'a.f',
    });
    const bF = occ({
      bodyHash: 'H',
      filePath: 'packages/pkg-b/src/f.ts',
      package: PKGB,
      qualifiedName: 'b.f',
    });
    const caller = occ({
      bodyHash: 'C',
      filePath: A,
      package: PKGA,
      simpleName: 'caller',
      calls: [edge({ to: ['H'] })],
    });
    const out = constrainCrossPackageEdges(catalogOf({ f: [aF, bF], caller: [caller] }));
    expect(out.functions.caller[0].calls[0].to).toEqual(['H']); // pkg-a candidate keeps it
  });

  it('drops only the unreachable targets of a multi-target edge', () => {
    const bF = occ({
      bodyHash: 'Hb',
      filePath: 'packages/pkg-b/src/f.ts',
      package: PKGB,
      qualifiedName: 'b.f',
    });
    const cF = occ({
      bodyHash: 'Hc',
      filePath: 'packages/pkg-c/src/f.ts',
      package: PKGC,
      qualifiedName: 'c.f',
    });
    const caller = occ({
      bodyHash: 'C',
      filePath: A,
      package: PKGA,
      simpleName: 'caller',
      calls: [edge({ to: ['Hb', 'Hc'] })],
    });
    const mi = moduleInit(A, PKGA, [PKGC]); // imports pkg-c only
    const out = constrainCrossPackageEdges(
      catalogOf({ f: [bF, cF], caller: [caller], '<module-init>': [mi] }),
    );
    expect(out.functions.caller[0].calls[0].to).toEqual(['Hc']); // pkg-b dropped, pkg-c (imported) kept
  });

  it('drops a name-guessed edge into another package’s test file (builtin .map/.find collision)', () => {
    const testArrow = occ({
      bodyHash: 'H',
      filePath: 'packages/pkg-b/src/__tests__/x.test.ts',
      package: PKGB,
      simpleName: 'map',
      inTestFile: true,
    });
    const caller = occ({
      bodyHash: 'C',
      filePath: A,
      package: PKGA,
      simpleName: 'caller',
      calls: [edge({ to: ['H'], text: 'xs.map(...)' })],
    });
    const mi = moduleInit(A, PKGA, [PKGB]); // pkg-a DOES import pkg-b
    const out = constrainCrossPackageEdges(
      catalogOf({ f: [testArrow], caller: [caller], '<module-init>': [mi] }),
    );
    expect(out.functions.caller[0].calls[0].to).toEqual([]); // cross-package test callee dropped
  });

  it('keeps a same-package test-file callee (test calling its own package’s test helper)', () => {
    const testHelper = occ({
      bodyHash: 'H',
      filePath: 'packages/pkg-a/src/__tests__/helper.test.ts',
      package: PKGA,
      inTestFile: true,
    });
    const caller = occ({
      bodyHash: 'C',
      filePath: 'packages/pkg-a/src/__tests__/x.test.ts',
      package: PKGA,
      simpleName: 'caller',
      inTestFile: true,
      calls: [edge({ to: ['H'] })],
    });
    const out = constrainCrossPackageEdges(catalogOf({ f: [testHelper], caller: [caller] }));
    expect(out.functions.caller[0].calls[0].to).toEqual(['H']); // same package ⇒ kept
  });

  it('ignores relative and external specifiers, unions multiple workspace imports', () => {
    const bF = occ({
      bodyHash: 'Hb',
      filePath: 'packages/pkg-b/src/f.ts',
      package: PKGB,
      qualifiedName: 'b.f',
    });
    const cF = occ({
      bodyHash: 'Hc',
      filePath: 'packages/pkg-c/src/f.ts',
      package: PKGC,
      qualifiedName: 'c.f',
    });
    const callB = occ({
      bodyHash: 'CB',
      filePath: A,
      package: PKGA,
      simpleName: 'callB',
      calls: [edge({ to: ['Hb'] })],
    });
    const callC = occ({
      bodyHash: 'CC',
      filePath: A,
      package: PKGA,
      simpleName: 'callC',
      calls: [edge({ to: ['Hc'] })],
    });
    const mi = moduleInit(A, PKGA, ['./local', 'lodash/fp', PKGB, PKGC]);
    const out = constrainCrossPackageEdges(
      catalogOf({ f: [bF, cF], callB: [callB], callC: [callC], '<module-init>': [mi] }),
    );
    expect(out.functions.callB[0].calls[0].to).toEqual(['Hb']);
    expect(out.functions.callC[0].calls[0].to).toEqual(['Hc']);
  });

  it('returns the catalog untouched in fast mode (no import set)', () => {
    const target = occ({ bodyHash: 'H', filePath: 'packages/pkg-b/src/f.ts', package: PKGB });
    const caller = occ({
      bodyHash: 'C',
      filePath: A,
      package: PKGA,
      simpleName: 'caller',
      calls: [edge({ to: ['H'] })],
    });
    const input = catalogOf({ f: [target], caller: [caller] }, 'fast');
    expect(constrainCrossPackageEdges(input)).toBe(input);
  });
});
