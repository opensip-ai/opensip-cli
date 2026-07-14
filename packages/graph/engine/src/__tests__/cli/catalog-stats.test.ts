import { describe, expect, it } from 'vitest';

import {
  countCatalogCallSites,
  countCatalogFunctions,
} from '../../cli/orchestrate/catalog-stats.js';

import type { Catalog, FunctionOccurrence } from '../../types.js';

function occurrence(over: Partial<FunctionOccurrence> = {}): FunctionOccurrence {
  return {
    bodyHash: 'h',
    simpleName: 'fn',
    qualifiedName: 'fn',
    filePath: 'src/a.ts',
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

function catalog(functions: Catalog['functions']): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-13T00:00:00.000Z',
    cacheKey: 'cache',
    functions,
  };
}

describe('catalog-stats', () => {
  it('counts only present occurrences and resolved call sites', () => {
    const sparse = catalog({
      present: [
        occurrence({
          calls: [
            {
              to: ['present'],
              line: 1,
              column: 0,
              resolution: 'static',
              confidence: 'high',
              text: 'present()',
            },
            {
              to: [],
              line: 2,
              column: 0,
              resolution: 'unresolved',
              confidence: 'low',
              text: 'missing()',
            },
          ],
        }),
      ],
      // Sparse map entries can be undefined after merges; both counters skip them.
      absent: undefined as unknown as FunctionOccurrence[],
    });

    expect(countCatalogFunctions(sparse)).toBe(1);
    expect(countCatalogCallSites(sparse)).toBe(1);
  });

  it('returns zero for empty catalogs', () => {
    const empty = catalog({});
    expect(countCatalogFunctions(empty)).toBe(0);
    expect(countCatalogCallSites(empty)).toBe(0);
  });
});
