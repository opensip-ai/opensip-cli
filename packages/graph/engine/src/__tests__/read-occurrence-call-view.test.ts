import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../pipeline/indexes.js';
import {
  buildOccurrenceCallGraph,
  occurrenceCallGraphFor,
} from '../pipeline/occurrence-call-graph.js';
import { buildOccurrenceCallView } from '../read/occurrence-call-view.js';

import type { SourceRoleMatcher } from '../read/index.js';
import type { Catalog, FunctionOccurrence } from '../types.js';

const noMatcher: SourceRoleMatcher = { matches: () => false };

function occurrence(
  partial: Partial<FunctionOccurrence> &
    Pick<FunctionOccurrence, 'bodyHash' | 'simpleName' | 'filePath'>,
): FunctionOccurrence {
  return {
    qualifiedName: partial.simpleName,
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

function call(
  to: readonly string[],
  line: number,
): NonNullable<FunctionOccurrence['calls']>[number] {
  return {
    to,
    line,
    column: 2,
    resolution: 'static',
    confidence: 'high',
    text: 'redacted by projection',
  };
}

function fixture(): Catalog {
  const productionOwner = occurrence({
    bodyHash: 'owner-body',
    simpleName: 'owner',
    filePath: 'src/owner.ts',
    calls: [call(['target-body', 'missing-body'], 4), call(['test-target-body'], 5)],
  });
  const testTwin = occurrence({
    bodyHash: 'owner-body',
    simpleName: 'ownerTwin',
    filePath: 'test/owner.test.ts',
    inTestFile: true,
    calls: [call(['other-body'], 3)],
  });
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-10T00:00:00.000Z',
    cacheKey: 'test',
    functions: {
      owner: [productionOwner],
      ownerTwin: [testTwin],
      target: [
        occurrence({
          bodyHash: 'target-body',
          simpleName: 'target',
          filePath: 'src/target.ts',
        }),
      ],
      other: [
        occurrence({
          bodyHash: 'other-body',
          simpleName: 'other',
          filePath: 'src/other.ts',
        }),
      ],
      testTarget: [
        occurrence({
          bodyHash: 'test-target-body',
          simpleName: 'testTarget',
          filePath: 'test/target.test.ts',
          inTestFile: true,
        }),
      ],
    },
  };
}

describe('buildOccurrenceCallView', () => {
  it('filters both twin edge endpoints before grouping and exposes every matching member', () => {
    const catalog = fixture();
    const result = buildOccurrenceCallView(
      catalog,
      buildIndexes(catalog),
      {
        identity: 'body-twin-union',
        filter: { sourceScope: 'production', generated: 'exclude' },
        startSymbolId: 'src/owner.ts:1:0',
        direction: 'callees',
        depth: 1,
      },
      noMatcher,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.members.get('owner-body')?.map((row) => row.symbolId)).toEqual([
      'src/owner.ts:1:0',
    ]);
    expect(result.value.forward.get('owner-body')).toEqual(['target-body']);
    expect(result.value.edges.map((edge) => [edge.from.symbolId, edge.to.symbolId])).toEqual([
      ['src/owner.ts:1:0', 'src/target.ts:1:0'],
    ]);
    expect(result.value.edges.some((edge) => 'text' in edge)).toBe(false);
    expect(result.value.edges.some((edge) => 'callSite' in edge)).toBe(false);
    expect(result.value.edges[0]?.source).toEqual({
      file: 'src/owner.ts',
      line: 4,
      column: 2,
    });
    expect(result.value.counts.excludedOccurrences).toBe(2);
    expect(result.value.counts.excludedEdges).toBe(2);
    expect(result.value.counts).toMatchObject({
      includedOccurrences: 2,
      includedEdges: 1,
      countScope: 'visited',
    });
  });

  it('retains unresolved targets from a mixed resolved/unresolved call and sorts adjacency', () => {
    const catalog = fixture();
    const indexes = buildIndexes(catalog);
    const graph = buildOccurrenceCallGraph(indexes);

    expect(graph.forward.get('src/owner.ts:1:0')).toEqual([
      'src/target.ts:1:0',
      'test/target.test.ts:1:0',
    ]);
    expect(graph.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerOccId: 'src/owner.ts:1:0',
          targetHashes: ['missing-body'],
        }),
      ]),
    );

    const view = buildOccurrenceCallView(
      catalog,
      indexes,
      {
        identity: 'occurrence',
        filter: { sourceScope: 'all', generated: 'include' },
        startSymbolId: 'src/owner.ts:1:0',
        direction: 'callees',
        depth: 1,
      },
      noMatcher,
    );
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.totalUnresolved).toBe(1);
    expect(view.value.unresolved[0]?.targetHashes).toEqual(['missing-body']);
    expect(view.value.unresolvedCounts).toEqual([
      { resolution: 'static', confidence: 'high', count: 1 },
    ]);
    expect([...view.value.forward.keys()]).toEqual([...view.value.forward.keys()].sort());
  });

  it('retains otherwise-identical evidence with distinct cross-shard provenance', () => {
    const catalog = fixture();
    const owner = catalog.functions.owner?.[0];
    if (owner === undefined) throw new Error('fixture owner missing');
    const local = call(['target-body'], 8);
    const withProvenance: Catalog = {
      ...catalog,
      functions: {
        ...catalog.functions,
        owner: [
          {
            ...owner,
            calls: [local, { ...local, crossShard: true }],
          },
        ],
      },
    };
    const result = buildOccurrenceCallView(
      withProvenance,
      buildIndexes(withProvenance),
      {
        identity: 'occurrence',
        filter: { sourceScope: 'production', generated: 'exclude' },
        startSymbolId: 'src/owner.ts:1:0',
        direction: 'callees',
        depth: 1,
      },
      noMatcher,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.edges.map((edge) => edge.crossShard)).toEqual([false, true]);
    expect(result.value.counts.includedEdges).toBe(2);
  });

  it('caps unresolved target detail after selecting the visited owner', () => {
    const catalog = fixture();
    const owner = catalog.functions.owner?.[0];
    if (owner === undefined) throw new Error('fixture owner missing');
    const targetHashes = Array.from(
      { length: 25 },
      (_, index) => `missing-${String(index).padStart(2, '0')}`,
    );
    const boundedCatalog: Catalog = {
      ...catalog,
      functions: {
        ...catalog.functions,
        owner: [{ ...owner, calls: [call(targetHashes, 9)] }],
      },
    };
    const result = buildOccurrenceCallView(
      boundedCatalog,
      buildIndexes(boundedCatalog),
      {
        identity: 'occurrence',
        filter: { sourceScope: 'production', generated: 'exclude' },
        startSymbolId: 'src/owner.ts:1:0',
        direction: 'callees',
        depth: 1,
      },
      noMatcher,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unresolved).toHaveLength(1);
    expect(result.value.unresolved[0]?.targetHashes).toHaveLength(20);
    expect(result.value.unresolved[0]?.totalTargetHashes).toBe(25);
    expect(result.value.coverage.reasons).toContain('unresolved-detail-cap');
  });

  it('labels the unresolved reverse-attribution limitation for caller queries', () => {
    const catalog = fixture();
    const result = buildOccurrenceCallView(
      catalog,
      buildIndexes(catalog),
      {
        identity: 'occurrence',
        filter: { sourceScope: 'production', generated: 'exclude' },
        startSymbolId: 'src/target.ts:1:0',
        direction: 'callers',
        depth: 1,
      },
      noMatcher,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unresolvedAttribution).toBe('owner-only');
    expect(result.value.coverage.reasons).toContain('unresolved-reverse-attribution-unavailable');
  });

  it('reuses one immutable occurrence graph for each generation index object', () => {
    const catalog = fixture();
    const indexes = buildIndexes(catalog);
    expect(occurrenceCallGraphFor(indexes)).toBe(occurrenceCallGraphFor(indexes));
    expect(occurrenceCallGraphFor(buildIndexes(catalog))).not.toBe(occurrenceCallGraphFor(indexes));
  });

  it('omits malformed persisted call provenance as partial without truncation', () => {
    const catalog = fixture();
    const owner = catalog.functions.owner?.[0];
    if (owner === undefined) throw new Error('fixture owner missing');
    const malformedCall = {
      ...call(['target-body'], 4),
      resolution: 'hostile',
      confidence: 'certain',
      line: Number.NaN,
      crossShard: 'yes',
    } as unknown as FunctionOccurrence['calls'][number];
    const malformedCatalog: Catalog = {
      ...catalog,
      functions: {
        ...catalog.functions,
        owner: [{ ...owner, calls: [malformedCall] }],
      },
    };
    const result = buildOccurrenceCallView(
      malformedCatalog,
      buildIndexes(malformedCatalog),
      {
        identity: 'occurrence',
        filter: { sourceScope: 'production', generated: 'exclude' },
        startSymbolId: 'src/owner.ts:1:0',
        direction: 'callees',
        depth: 1,
      },
      noMatcher,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.edges).toEqual([]);
    expect(result.value.coverage).toMatchObject({
      complete: false,
      truncated: false,
    });
    expect(result.value.coverage.reasons).toContain('malformed-call-edge-omitted');
  });

  it('omits unresolved summaries whose owner cannot cross the public symbol boundary', () => {
    const secretPath = '/private/catalog-owner.ts';
    const malformedOwner = occurrence({
      bodyHash: 'malformed-owner',
      simpleName: 'malformedOwner',
      filePath: secretPath,
      calls: [call(['missing-target'], 3)],
    });
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: '2026-07-10T00:00:00.000Z',
      cacheKey: 'malformed-owner',
      functions: { malformedOwner: [malformedOwner] },
    };
    const result = buildOccurrenceCallView(
      catalog,
      buildIndexes(catalog),
      {
        identity: 'occurrence',
        filter: { sourceScope: 'all', generated: 'include' },
        direction: 'callees',
        depth: 1,
      },
      noMatcher,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unresolved).toEqual([]);
    expect(result.value.totalUnresolved).toBe(0);
    expect(result.value.coverage.reasons).toContain('malformed-symbol-omitted');
    expect(JSON.stringify(result.value)).not.toContain(secretPath);
  });

  it.each(['bad\u0085target', 'x'.repeat(129)])(
    'omits malformed persisted target hash %j before graph construction',
    (targetHash) => {
      const catalog = fixture();
      const owner = catalog.functions.owner?.[0];
      if (owner === undefined) throw new Error('fixture owner missing');
      const malformedCatalog: Catalog = {
        ...catalog,
        functions: {
          ...catalog.functions,
          owner: [{ ...owner, calls: [call([targetHash], 9)] }],
        },
      };
      const graph = buildOccurrenceCallGraph(buildIndexes(malformedCatalog));
      expect(graph.edges.filter((edge) => edge.fromOccId === 'src/owner.ts:1:0')).toEqual([]);
      expect(graph.unresolved).toEqual([]);
      expect(graph.malformedCalls).toBe(1);
    },
  );

  it('bounds dense resolved evidence and streams unresolved summaries', () => {
    const hashes = Array.from({ length: 150 }, (_, index) => `body-${index}`);
    const dense = hashes.map((bodyHash, index) =>
      occurrence({
        bodyHash,
        simpleName: `node${index}`,
        filePath: `src/node-${index}.ts`,
        calls: [
          call(hashes, index + 1),
          ...(index === 0
            ? Array.from({ length: 1000 }, (_, unresolvedIndex) => call([], unresolvedIndex + 200))
            : []),
        ],
      }),
    );
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: '2026-07-10T00:00:00.000Z',
      cacheKey: 'dense',
      functions: { dense },
    };
    const result = buildOccurrenceCallView(
      catalog,
      buildIndexes(catalog),
      {
        identity: 'occurrence',
        filter: { sourceScope: 'all', generated: 'include' },
        startSymbolId: 'src/node-0.ts:1:0',
        direction: 'callees',
        depth: 1,
      },
      noMatcher,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.edges).toHaveLength(20_000);
    expect(result.value.totalUnresolved).toBe(1000);
    expect(result.value.unresolved).toHaveLength(50);
    expect(result.value.coverage.reasons).toEqual(
      expect.arrayContaining(['resolved-evidence-cap', 'unresolved-sample-cap']),
    );
    expect(result.value.coverage.truncated).toBe(true);
  });
});
