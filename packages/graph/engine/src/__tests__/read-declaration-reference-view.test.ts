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
    const id = sampleBundle.declarations[0]!.declarationId;
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
});
