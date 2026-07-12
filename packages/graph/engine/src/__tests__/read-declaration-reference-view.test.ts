import { describe, expect, it } from 'vitest';

import {
  referencesToDeclaration,
  searchDeclarationFacts,
} from '../read/declaration-reference-view.js';
import { compileSourceRoleMatcher } from '../read/source-filter.js';

import type { Catalog, SemanticFactBundle } from '../types.js';

const noMatcher = compileSourceRoleMatcher(undefined, [], { maxFiles: 1 });
if (!noMatcher.ok) throw new Error('matcher');

function catalog(semanticFacts?: SemanticFactBundle, resolutionMode?: 'exact' | 'fast'): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-11T00:00:00.000Z',
    cacheKey: 'test',
    functions: {},
    ...(resolutionMode === undefined ? {} : { resolutionMode }),
    ...(semanticFacts === undefined ? {} : { semanticFacts }),
  };
}

const sampleBundle: SemanticFactBundle = {
  referenceScope: 'cross-file',
  declarations: [
    {
      declarationId: 'd1|pkg|src/types.ts|interface|Foo|0000000000000001|0000000000000000',
      name: 'Foo',
      qualifiedName: 'src/types.Foo',
      kind: 'interface',
      package: 'pkg',
      filePath: 'src/types.ts',
      line: 1,
      column: 0,
      endLine: 3,
      endColumn: 1,
      visibility: 'exported',
      exportRole: 'named-export',
      inTestFile: false,
      definedInGenerated: false,
    },
  ],
  references: [
    {
      referenceId: 'r1|src/use.ts|type|0000000000000002|0000000000000000|d1',
      kind: 'type',
      filePath: 'src/use.ts',
      line: 2,
      column: 0,
      endLine: 2,
      endColumn: 3,
      package: 'pkg',
      targetDeclarationId: 'd1|pkg|src/types.ts|interface|Foo|0000000000000001|0000000000000000',
      targetPackage: 'pkg',
      targetName: 'Foo',
      targetKind: 'interface',
      basis: 'compiler-declaration',
      confidence: 'high',
      inTestFile: false,
      definedInGenerated: false,
    },
  ],
  coverage: {
    status: 'complete',
    inspectedDeclarations: 1,
    emittedDeclarations: 1,
    omittedDeclarations: 0,
    inspectedReferences: 1,
    emittedReferences: 1,
    omittedReferences: 0,
    reasons: [],
  },
};

const filter = { sourceScope: 'all' as const, generated: 'include' as const };

describe('searchDeclarationFacts', () => {
  it('reports unsupported inventory when the plane is absent', () => {
    const result = searchDeclarationFacts(
      catalog(undefined, 'fast'),
      { query: 'Foo', match: 'substring', filter, limit: 20 },
      noMatcher.value,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unsupported).toBe(true);
    expect(result.value.declarations).toEqual([]);
    expect(result.value.coverage.inventory.complete).toBe(false);
    expect(result.value.coverage.inventory.reasons).toContain('semantic-facts-unsupported');
  });

  it('returns present-empty exact data as complete inventory', () => {
    const empty: SemanticFactBundle = {
      referenceScope: 'cross-file',
      declarations: [],
      references: [],
      coverage: {
        status: 'complete',
        inspectedDeclarations: 0,
        emittedDeclarations: 0,
        omittedDeclarations: 0,
        inspectedReferences: 0,
        emittedReferences: 0,
        omittedReferences: 0,
        reasons: [],
      },
    };
    const result = searchDeclarationFacts(
      catalog(empty, 'exact'),
      { query: 'Foo', match: 'substring', filter, limit: 20 },
      noMatcher.value,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unsupported).toBe(false);
    expect(result.value.coverage.inventory.complete).toBe(true);
  });

  it('matches exact name and filters by kind', () => {
    const result = searchDeclarationFacts(
      catalog(sampleBundle),
      {
        query: 'Foo',
        match: 'exact',
        filter,
        kinds: ['interface'],
        limit: 20,
      },
      noMatcher.value,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalMatches).toBe(1);
    expect(result.value.declarations[0]?.name).toBe('Foo');
  });

  it('matches substring and qualified modes and groups by package', () => {
    const multi: SemanticFactBundle = {
      ...sampleBundle,
      declarations: [
        sampleBundle.declarations[0],
        {
          ...sampleBundle.declarations[0],
          declarationId:
            'd1|pkg|src/types.ts|type-alias|FooAlias|0000000000000002|0000000000000000',
          name: 'FooAlias',
          qualifiedName: 'src/types.FooAlias',
          kind: 'type-alias',
          line: 4,
        },
      ],
    };
    const sub = searchDeclarationFacts(
      catalog(multi),
      { query: 'foo', match: 'substring', filter, limit: 20 },
      noMatcher.value,
    );
    expect(sub.ok && sub.value.totalMatches).toBe(2);

    const qualified = searchDeclarationFacts(
      catalog(multi),
      { query: 'src/types.Foo', match: 'qualified', filter, limit: 20 },
      noMatcher.value,
    );
    expect(qualified.ok && qualified.value.totalMatches).toBe(1);

    const grouped = searchDeclarationFacts(
      catalog(multi),
      { query: 'Foo', match: 'substring', filter, limit: 20, groupBy: 'package' },
      noMatcher.value,
    );
    expect(grouped.ok && grouped.value.groups?.some((g) => g.key === 'pkg')).toBe(true);

    const paged = searchDeclarationFacts(
      catalog(multi),
      { query: 'Foo', match: 'substring', filter, limit: 1 },
      noMatcher.value,
    );
    expect(paged.ok && paged.value.hasMore).toBe(true);
  });

  it('propagates partial producer coverage reasons', () => {
    const partial: SemanticFactBundle = {
      ...sampleBundle,
      coverage: {
        ...sampleBundle.coverage,
        status: 'partial',
        omittedDeclarations: 1,
        reasons: ['declaration-cap'],
      },
    };
    const result = searchDeclarationFacts(
      catalog(partial, 'exact'),
      { query: 'Foo', match: 'exact', filter, limit: 20 },
      noMatcher.value,
    );
    expect(result.ok && result.value.coverage.inventory.complete).toBe(false);
    expect(result.ok && result.value.coverage.inventory.reasons).toContain('declaration-cap');
  });

  it('filters by package and generated policy', () => {
    const generated: SemanticFactBundle = {
      ...sampleBundle,
      declarations: [
        {
          ...sampleBundle.declarations[0],
          package: 'other',
          definedInGenerated: true,
          declarationId: 'd1|other|src/gen.ts|interface|Foo|0000000000000009|0000000000000000',
          filePath: 'src/gen.ts',
        },
      ],
    };
    const miss = searchDeclarationFacts(
      catalog(generated),
      {
        query: 'Foo',
        match: 'exact',
        filter: { sourceScope: 'all', generated: 'exclude', packages: ['pkg'] },
        limit: 20,
      },
      noMatcher.value,
    );
    expect(miss.ok && miss.value.totalMatches).toBe(0);
  });
});

describe('referencesToDeclaration', () => {
  it('returns declarationMissing for unknown ids', () => {
    const result = referencesToDeclaration(
      catalog(sampleBundle),
      { declarationId: 'missing', filter, limit: 20 },
      noMatcher.value,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.declarationMissing).toBe(true);
  });

  it('returns cross-file references for a known id', () => {
    const id = sampleBundle.declarations[0].declarationId;
    const result = referencesToDeclaration(
      catalog(sampleBundle),
      { declarationId: id, filter, limit: 20 },
      noMatcher.value,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.declarationMissing).toBe(false);
    expect(result.value.totalMatches).toBe(1);
    expect(result.value.references[0]?.filePath).toBe('src/use.ts');
    expect(result.value.referenceScope).toBe('cross-file');
  });

  it('reports unsupported when semantic plane is absent', () => {
    const result = referencesToDeclaration(
      catalog(undefined, 'exact'),
      { declarationId: 'd1|x', filter, limit: 20 },
      noMatcher.value,
    );
    expect(result.ok && result.value.unsupported).toBe(true);
  });

  it('filters references by kind and groups by file', () => {
    const id = sampleBundle.declarations[0].declarationId;
    const kindMiss = referencesToDeclaration(
      catalog(sampleBundle),
      { declarationId: id, filter, kinds: ['import'], limit: 20 },
      noMatcher.value,
    );
    expect(kindMiss.ok && kindMiss.value.totalMatches).toBe(0);

    const grouped = referencesToDeclaration(
      catalog(sampleBundle),
      { declarationId: id, filter, kinds: ['type'], limit: 20, groupBy: 'file' },
      noMatcher.value,
    );
    expect(grouped.ok && grouped.value.groups?.some((g) => g.key === 'src/use.ts')).toBe(true);
  });
});
