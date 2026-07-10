import { describe, expect, it } from 'vitest';

import { compareCodePointStrings, continuationToken } from '../code-point-order.js';
import { buildIndexes } from '../pipeline/indexes.js';
import { toGraphSymbolRef, type GraphSourceFilter } from '../read/query-contracts.js';
import {
  searchSymbolOccurrences,
  symbolSearchStableKey,
  type SymbolSearchQuery,
} from '../read/symbol-search.js';

import type { Catalog, FunctionOccurrence } from '../types.js';

function occ(
  partial: Partial<FunctionOccurrence> &
    Pick<FunctionOccurrence, 'bodyHash' | 'simpleName' | 'filePath' | 'line'>,
): FunctionOccurrence {
  return {
    qualifiedName: partial.simpleName,
    column: 0,
    endLine: (partial.line ?? 1) + 4,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    package: 'pkg',
    ...partial,
  };
}

function catalogFrom(occs: FunctionOccurrence[]): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const o of occs) {
    const list = functions[o.simpleName] ?? [];
    list.push(o);
    functions[o.simpleName] = list;
  }
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-09T00:00:00.000Z',
    cacheKey: 'test',
    filesFingerprint: '0',
    functions,
  };
}

const allFilter = (): GraphSourceFilter => ({
  sourceScope: 'all',
  generated: 'include',
});

function search(
  catalog: Catalog,
  over: Partial<SymbolSearchQuery> & Pick<SymbolSearchQuery, 'query'>,
) {
  const indexes = buildIndexes(catalog);
  return searchSymbolOccurrences(catalog, indexes, {
    match: 'substring',
    filter: allFilter(),
    limit: 50,
    ...over,
  });
}

describe('searchSymbolOccurrences', () => {
  const multi = catalogFrom([
    occ({
      bodyHash: 'h1',
      simpleName: 'save',
      qualifiedName: 'api.save',
      filePath: 'src/api/save.ts',
      line: 1,
      kind: 'function-declaration',
    }),
    occ({
      bodyHash: 'h2',
      simpleName: 'saveBaseline',
      qualifiedName: 'fit.saveBaseline',
      filePath: 'src/fit/baseline.ts',
      line: 10,
      kind: 'method',
    }),
    occ({
      bodyHash: 'h3',
      simpleName: 'Save',
      qualifiedName: 'cli.Save',
      filePath: 'src/cli/save.ts',
      line: 2,
      kind: 'function-declaration',
    }),
    occ({
      bodyHash: 'h4',
      simpleName: 'helper',
      qualifiedName: 'test.helper',
      filePath: 'src/helper.test.ts',
      line: 1,
      inTestFile: true,
      kind: 'function-declaration',
    }),
    occ({
      bodyHash: 'h5',
      simpleName: 'genHelper',
      qualifiedName: 'gen.genHelper',
      filePath: 'gen/helper.ts',
      line: 1,
      definedInGenerated: true,
    }),
    // module-init must never appear
    occ({
      bodyHash: 'h-mod',
      simpleName: '<module-init>',
      qualifiedName: 'src/mod.ts',
      filePath: 'src/mod.ts',
      line: 1,
      kind: 'module-init',
    }),
    // duplicate simpleName different files
    occ({
      bodyHash: 'h6',
      simpleName: 'save',
      qualifiedName: 'other.save',
      filePath: 'src/other/save.ts',
      line: 5,
      package: 'other',
      kind: 'function-declaration',
    }),
  ]);

  it('matches substring case-insensitively on simpleName', () => {
    const result = search(multi, { query: 'save', match: 'substring' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.symbols.map((s) => s.simpleName).sort();
    // save, saveBaseline, Save
    expect(names).toEqual(['Save', 'save', 'save', 'saveBaseline']);
  });

  it('matches exact case-sensitively on simpleName', () => {
    const result = search(multi, { query: 'save', match: 'exact' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.symbols.every((s) => s.simpleName === 'save')).toBe(true);
    expect(result.value.symbols).toHaveLength(2);
  });

  it('matches qualified case-sensitively on qualifiedName', () => {
    const result = search(multi, { query: 'fit.saveBaseline', match: 'qualified' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.symbols).toHaveLength(1);
    expect(result.value.symbols[0]?.symbolId).toBe('src/fit/baseline.ts:10:0');
  });

  it('excludes module-init always', () => {
    const result = search(multi, { query: 'module', match: 'substring' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.symbols.every((s) => s.kind !== 'module-init')).toBe(true);
  });

  it('applies kind filter BEFORE limit (old post-limit bug regression)', () => {
    // Many function-declaration matches of "save*" style, only one method.
    // With limit=1 and kind=method, post-limit filtering would return empty
    // if the first capped row was a function-declaration.
    const result = search(multi, {
      query: 'save',
      match: 'substring',
      limit: 1,
      filter: {
        sourceScope: 'all',
        generated: 'include',
        kinds: ['method'],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.symbols).toHaveLength(1);
    expect(result.value.symbols[0]?.kind).toBe('method');
    expect(result.value.symbols[0]?.simpleName).toBe('saveBaseline');
  });

  it('filters by package, filePath, filePrefix, visibility, source, generated', () => {
    const byPkg = search(multi, {
      query: 'save',
      match: 'exact',
      filter: { sourceScope: 'all', generated: 'include', packages: ['other'] },
    });
    expect(byPkg.ok && byPkg.value.symbols).toHaveLength(1);
    expect(byPkg.ok && byPkg.value.symbols[0]?.package).toBe('other');

    const byFile = search(multi, {
      query: 'save',
      match: 'substring',
      filter: {
        sourceScope: 'all',
        generated: 'include',
        filePath: 'src/fit/baseline.ts',
      },
    });
    expect(byFile.ok && byFile.value.symbols).toHaveLength(1);

    const byPrefix = search(multi, {
      query: 'save',
      match: 'substring',
      filter: { sourceScope: 'all', generated: 'include', filePrefix: 'src/api' },
    });
    expect(byPrefix.ok && byPrefix.value.symbols).toHaveLength(1);

    const prod = search(multi, {
      query: 'helper',
      match: 'substring',
      filter: { sourceScope: 'production', generated: 'exclude' },
    });
    expect(prod.ok && prod.value.symbols).toHaveLength(0);

    const tests = search(multi, {
      query: 'helper',
      match: 'substring',
      filter: { sourceScope: 'test', generated: 'include' },
    });
    expect(tests.ok && tests.value.symbols).toHaveLength(1);

    const genOnly = search(multi, {
      query: 'Helper',
      match: 'substring',
      filter: { sourceScope: 'all', generated: 'only' },
    });
    expect(genOnly.ok && genOnly.value.symbols).toHaveLength(1);
    expect(genOnly.ok && genOnly.value.symbols[0]?.definedInGenerated).toBe(true);
  });

  it('orders deterministically by qualified/file/line/col/symbolId', () => {
    const result = search(multi, { query: 'save', match: 'exact', limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = result.value.symbols.map(symbolSearchStableKey);
    const sorted = [...keys].sort(compareCodePointStrings);
    expect(keys).toEqual(sorted);
  });

  it('bounded top-K: limit+1 window sets hasMore and does not over-return', () => {
    const first = search(multi, { query: 'save', match: 'substring', limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.symbols).toHaveLength(2);
    expect(first.value.hasMore).toBe(true);

    const secondSymbol = first.value.symbols[1];
    expect(secondSymbol).toBeDefined();
    if (secondSymbol === undefined) return;
    const afterKey = symbolSearchStableKey(secondSymbol);
    const second = search(multi, {
      query: 'save',
      match: 'substring',
      limit: 2,
      afterKey: continuationToken(afterKey),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Remaining matches after the first page
    expect(second.value.symbols.length).toBeGreaterThan(0);
    for (const s of second.value.symbols) {
      expect(compareCodePointStrings(symbolSearchStableKey(s), afterKey)).toBeGreaterThan(0);
    }
  });

  it('echoes effective filter', () => {
    const filter: GraphSourceFilter = {
      sourceScope: 'production',
      generated: 'exclude',
      kinds: ['function-declaration'],
    };
    const result = search(multi, { query: 'x', filter });
    expect(result.ok && result.value.effectiveFilter).toEqual(filter);
  });

  it('uses numeric line/column order in stable continuation keys', () => {
    const catalog = catalogFrom([
      occ({
        bodyHash: 'line-10',
        simpleName: 'same',
        qualifiedName: 'same',
        filePath: 'src/same.ts',
        line: 10,
      }),
      occ({
        bodyHash: 'line-2',
        simpleName: 'same',
        qualifiedName: 'same',
        filePath: 'src/same.ts',
        line: 2,
      }),
    ]);
    const first = search(catalog, { query: 'same', match: 'exact', limit: 1 });
    expect(first.ok && first.value.symbols[0]?.line).toBe(2);
    if (!first.ok || first.value.symbols[0] === undefined) return;
    const second = search(catalog, {
      query: 'same',
      match: 'exact',
      limit: 1,
      afterKey: continuationToken(symbolSearchStableKey(first.value.symbols[0])),
    });
    expect(second.ok && second.value.symbols[0]?.line).toBe(10);
  });

  it('orders BMP and supplementary characters by Unicode code point, not UTF-16 units', () => {
    const bmp = '\uE000';
    const supplementary = '\u{10000}';
    const catalog = catalogFrom([
      occ({
        bodyHash: 'supplementary',
        simpleName: 'findSupplementary',
        qualifiedName: `${supplementary}.find`,
        filePath: 'src/supplementary.ts',
        line: 1,
      }),
      occ({
        bodyHash: 'bmp',
        simpleName: 'findBmp',
        qualifiedName: `${bmp}.find`,
        filePath: 'src/bmp.ts',
        line: 1,
      }),
    ]);
    const result = search(catalog, { query: 'find', limit: 10 });
    expect(result.ok && result.value.symbols.map((row) => row.bodyHash)).toEqual([
      'bmp',
      'supplementary',
    ]);
  });

  it('groups the full filtered result set rather than the current page', () => {
    const catalog = catalogFrom([
      occ({
        bodyHash: 'a',
        simpleName: 'lookupA',
        filePath: 'packages/a/src/a.ts',
        package: 'a',
        line: 1,
      }),
      occ({
        bodyHash: 'b',
        simpleName: 'lookupB',
        filePath: 'packages/b/src/b.ts',
        package: 'b',
        line: 1,
      }),
      occ({
        bodyHash: 'c',
        simpleName: 'lookupC',
        filePath: 'packages/c/src/c.ts',
        package: 'c',
        line: 1,
      }),
    ]);
    const result = search(catalog, { query: 'lookup', limit: 1, groupBy: 'package' });
    expect(result.ok && result.value.symbols).toHaveLength(1);
    expect(result.ok && result.value.groups).toEqual([
      { key: 'a', count: 1 },
      { key: 'b', count: 1 },
      { key: 'c', count: 1 },
    ]);
  });

  it('omits C1-control-bearing catalog identities without claiming hard truncation', () => {
    const catalog = catalogFrom([
      occ({
        bodyHash: 'bad-control',
        simpleName: 'findMe',
        qualifiedName: 'bad\u0085.findMe',
        filePath: 'src/find.ts',
        line: 1,
      }),
    ]);
    const result = search(catalog, { query: 'find', limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.symbols).toEqual([]);
    expect(result.value.coverage).toEqual({
      complete: false,
      truncated: false,
      reasons: ['malformed-symbol-omitted'],
    });
  });

  it('rejects malformed persisted enum and boolean metadata at the public DTO boundary', () => {
    const valid = occ({
      bodyHash: 'valid',
      simpleName: 'valid',
      filePath: 'src/valid.ts',
      line: 1,
    });
    expect(
      toGraphSymbolRef({ ...valid, kind: 'bad\u0085kind' } as unknown as FunctionOccurrence),
    ).toBeUndefined();
    expect(
      toGraphSymbolRef({ ...valid, visibility: 'public' } as unknown as FunctionOccurrence),
    ).toBeUndefined();
    expect(
      toGraphSymbolRef({ ...valid, inTestFile: 'false' } as unknown as FunctionOccurrence),
    ).toBeUndefined();
    expect(
      toGraphSymbolRef({
        ...valid,
        definedInGenerated: 0,
      } as unknown as FunctionOccurrence),
    ).toBeUndefined();
  });
});
