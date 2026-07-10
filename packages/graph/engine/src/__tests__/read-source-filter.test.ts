import { describe, expect, it } from 'vitest';

import {
  GRAPH_SYMBOL_NAME_MAX,
  GRAPH_SYMBOL_PATH_MAX,
  matchesFilePrefix,
  matchesGraphSourceFilter,
  toGraphSymbolRef,
  type GraphSourceFilter,
} from '../read/index.js';

import type { FunctionOccurrence } from '../types.js';

function occ(
  partial: Partial<FunctionOccurrence> & Pick<FunctionOccurrence, 'filePath'>,
): FunctionOccurrence {
  return {
    bodyHash: 'hash',
    simpleName: 'fn',
    qualifiedName: 'pkg.fn',
    line: 1,
    column: 0,
    endLine: 5,
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

const baseFilter = (): GraphSourceFilter => ({
  sourceScope: 'all',
  generated: 'include',
});

describe('matchesFilePrefix', () => {
  it('matches exact path and descendants, not sibling prefixes', () => {
    expect(matchesFilePrefix('src/api', 'src/api')).toBe(true);
    expect(matchesFilePrefix('src/api/x.ts', 'src/api')).toBe(true);
    expect(matchesFilePrefix('src/api-old/x.ts', 'src/api')).toBe(false);
    expect(matchesFilePrefix('src/apix.ts', 'src/api')).toBe(false);
  });
});

describe('matchesGraphSourceFilter', () => {
  it('filters by source scope', () => {
    const production = occ({ filePath: 'src/a.ts', inTestFile: false });
    const test = occ({ filePath: 'src/a.test.ts', inTestFile: true });
    expect(
      matchesGraphSourceFilter(production, { ...baseFilter(), sourceScope: 'production' }),
    ).toBe(true);
    expect(matchesGraphSourceFilter(test, { ...baseFilter(), sourceScope: 'production' })).toBe(
      false,
    );
    expect(matchesGraphSourceFilter(test, { ...baseFilter(), sourceScope: 'test' })).toBe(true);
    expect(matchesGraphSourceFilter(production, { ...baseFilter(), sourceScope: 'test' })).toBe(
      false,
    );
  });

  it('filters by generated policy', () => {
    const generated = occ({ filePath: 'gen/a.ts', definedInGenerated: true });
    const source = occ({ filePath: 'src/a.ts', definedInGenerated: false });
    expect(matchesGraphSourceFilter(generated, { ...baseFilter(), generated: 'exclude' })).toBe(
      false,
    );
    expect(matchesGraphSourceFilter(source, { ...baseFilter(), generated: 'exclude' })).toBe(true);
    expect(matchesGraphSourceFilter(generated, { ...baseFilter(), generated: 'only' })).toBe(true);
    expect(matchesGraphSourceFilter(source, { ...baseFilter(), generated: 'only' })).toBe(false);
  });

  it('filters by package, kind, visibility, exact path, and prefix', () => {
    const row = occ({
      filePath: 'src/api/handler.ts',
      package: '@opensip-cli/api',
      kind: 'method',
      visibility: 'exported',
    });
    expect(
      matchesGraphSourceFilter(row, {
        ...baseFilter(),
        packages: ['@opensip-cli/api'],
        kinds: ['method'],
        visibilities: ['exported'],
        filePath: 'src/api/handler.ts',
        filePrefix: 'src/api',
      }),
    ).toBe(true);
    expect(matchesGraphSourceFilter(row, { ...baseFilter(), packages: ['other'] })).toBe(false);
    expect(matchesGraphSourceFilter(row, { ...baseFilter(), kinds: ['arrow'] })).toBe(false);
    expect(matchesGraphSourceFilter(row, { ...baseFilter(), visibilities: ['private'] })).toBe(
      false,
    );
    expect(matchesGraphSourceFilter(row, { ...baseFilter(), filePath: 'src/other.ts' })).toBe(
      false,
    );
    expect(matchesGraphSourceFilter(row, { ...baseFilter(), filePrefix: 'src/api-old' })).toBe(
      false,
    );
  });

  it('requires both exact path and prefix when both are set', () => {
    const row = occ({ filePath: 'src/api/handler.ts' });
    expect(
      matchesGraphSourceFilter(row, {
        ...baseFilter(),
        filePath: 'src/api/handler.ts',
        filePrefix: 'src/other',
      }),
    ).toBe(false);
  });
});

describe('toGraphSymbolRef', () => {
  it('projects a well-formed occurrence with package/test/generated metadata', () => {
    const ref = toGraphSymbolRef(
      occ({
        filePath: 'src/a.ts',
        simpleName: 'save',
        qualifiedName: 'pkg.save',
        package: 'pkg',
        inTestFile: true,
        definedInGenerated: false,
        line: 10,
        endLine: 12,
        column: 2,
      }),
    );
    expect(ref).toEqual({
      symbolId: 'src/a.ts:10:2',
      bodyHash: 'hash',
      simpleName: 'save',
      qualifiedName: 'pkg.save',
      filePath: 'src/a.ts',
      line: 10,
      column: 2,
      kind: 'function-declaration',
      visibility: 'module-local',
      package: 'pkg',
      inTestFile: true,
      definedInGenerated: false,
    });
  });

  it('omits oversized or control-containing identity fields instead of truncating', () => {
    expect(
      toGraphSymbolRef(occ({ filePath: 'x'.repeat(GRAPH_SYMBOL_PATH_MAX + 1) })),
    ).toBeUndefined();
    expect(toGraphSymbolRef(occ({ filePath: 'src/a.ts', simpleName: 'a\u0000b' }))).toBeUndefined();
    expect(
      toGraphSymbolRef(
        occ({ filePath: 'src/a.ts', qualifiedName: 'n'.repeat(GRAPH_SYMBOL_NAME_MAX + 1) }),
      ),
    ).toBeUndefined();
    expect(toGraphSymbolRef(occ({ filePath: 'src/a.ts', line: 10, endLine: 9 }))).toBeUndefined();
  });
});
