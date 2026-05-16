/**
 * cache/normalize round-trip test (DRY-4).
 *
 * Asserts that normalizeCatalogForSerialization produces a stable
 * shape across two serializations — what we wrote is what we read.
 */

import { describe, expect, it } from 'vitest';

import { normalizeCatalogForSerialization } from '../../cache/normalize.js';

import type { Catalog, FunctionOccurrence } from '../../types.js';

function occ(over: Partial<FunctionOccurrence>): FunctionOccurrence {
  return {
    bodyHash: 'abc',
    simpleName: 'foo',
    qualifiedName: 'src/a.foo',
    filePath: 'src/a.ts',
    line: 1,
    column: 0,
    endLine: 1,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...over,
  };
}

describe('normalizeCatalogForSerialization (DRY-4)', () => {
  it('round-trips a catalog byte-identical via JSON.stringify', () => {
    const catalog: Catalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: '2026-05-16T00:00:00.000Z',
      tsConfigPath: '/tsconfig.json',
      tsCompilerVersion: '5.7.0',
      functions: {
        beta: [occ({ simpleName: 'beta', filePath: 'src/b.ts', bodyHash: 'b' })],
        alpha: [
          occ({ simpleName: 'alpha', filePath: 'src/a.ts', line: 5, bodyHash: 'a1' }),
          occ({ simpleName: 'alpha', filePath: 'src/a.ts', line: 1, bodyHash: 'a2' }),
        ],
      },
    };
    const a = JSON.stringify(normalizeCatalogForSerialization(catalog));
    const b = JSON.stringify(normalizeCatalogForSerialization(catalog));
    expect(a).toBe(b);
  });

  it('produces sorted top-level keys', () => {
    const catalog: Catalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'x',
      tsConfigPath: 'x',
      tsCompilerVersion: 'x',
      functions: {
        zebra: [occ({ simpleName: 'zebra' })],
        apple: [occ({ simpleName: 'apple' })],
      },
    };
    const norm = normalizeCatalogForSerialization(catalog);
    expect(Object.keys(norm.functions)).toEqual(['apple', 'zebra']);
  });

  it('sorts occurrences within a name by file/line/column', () => {
    const catalog: Catalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'x',
      tsConfigPath: 'x',
      tsCompilerVersion: 'x',
      functions: {
        foo: [
          occ({ simpleName: 'foo', filePath: 'src/b.ts', line: 1, bodyHash: 'b' }),
          occ({ simpleName: 'foo', filePath: 'src/a.ts', line: 5, bodyHash: 'a5' }),
          occ({ simpleName: 'foo', filePath: 'src/a.ts', line: 1, bodyHash: 'a1' }),
        ],
      },
    };
    const norm = normalizeCatalogForSerialization(catalog);
    const order = norm.functions.foo.map((o) => `${o.filePath}:${o.line.toString()}`);
    expect(order).toEqual(['src/a.ts:1', 'src/a.ts:5', 'src/b.ts:1']);
  });
});
