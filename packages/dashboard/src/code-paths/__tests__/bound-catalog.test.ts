import { describe, expect, it } from 'vitest';

import { boundGraphCatalog, MAX_GRAPH_CATALOG_BYTES } from '../bound-catalog.js';

import type { GraphCatalog } from '@opensip-cli/contracts';

function occurrence(hash: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bodyHash: hash,
    simpleName: `fn_${hash}`,
    qualifiedName: `pkg/mod#fn_${hash}`,
    filePath: `src/${hash}.ts`,
    package: 'pkg',
    line: 1,
    endLine: 9,
    column: 0,
    kind: 'function',
    visibility: 'public',
    inTestFile: false,
    returnType: 'void',
    params: [],
    calls: [],
    // Storage-only fields the browser never reads.
    bodySize: 4096,
    bodySignature: 'x'.repeat(64),
    enclosingClass: 'Big',
    decorators: ['@a', '@b'],
    definedInGenerated: false,
    ...extra,
  };
}

function catalog(
  functionCount: number,
  opts: { blast?: (i: number) => number } = {},
): GraphCatalog {
  const functions: Record<string, unknown[]> = {};
  const metrics: Record<string, unknown> = {};
  for (let i = 0; i < functionCount; i++) {
    const hash = `h${String(i).padStart(4, '0')}`;
    functions[hash] = [occurrence(hash)];
    metrics[hash] = { bodyLines: 10, blast: { score: opts.blast?.(i) ?? 0 } };
  }
  return {
    version: '2.0',
    language: 'typescript',
    cacheKey: 'ck',
    builtAt: '2026-07-14T00:00:00.000Z',
    resolutionMode: 'exact',
    functions,
    // Storage/MCP payloads the report must not inline — `semanticFacts` alone
    // was 204 MB of the 293 MB report that motivated this bounding.
    semanticFacts: { declarations: ['x'.repeat(10_000)] },
    reExports: ['y'.repeat(10_000)],
    features: {
      function: metrics,
      package: { pkg: { churn: 1 } },
      edge: [{ from: 'a', to: 'b', weight: 1 }],
      scc: [['a', 'b']],
    },
  } as unknown as GraphCatalog;
}

describe('boundGraphCatalog', () => {
  it('returns an empty result for a missing catalog', () => {
    expect(boundGraphCatalog(null)).toEqual({
      catalog: null,
      totalFunctions: 0,
      omittedFunctions: 0,
    });
    expect(boundGraphCatalog(undefined).catalog).toBeNull();
  });

  it('drops the storage-only payloads the browser never reads', () => {
    const { catalog: projected } = boundGraphCatalog(catalog(3));
    const keys = Object.keys(projected ?? {});

    expect(keys).not.toContain('semanticFacts');
    expect(keys).not.toContain('reExports');
    expect(projected?.cacheKey).toBe('ck');
    expect(projected?.resolutionMode).toBe('exact');
  });

  it('keeps every catalog field the browser actually reads', () => {
    // The client reads the catalog STRUCTURALLY (`CatalogLike` has an index
    // signature), so trimming a field the type does not declare still breaks
    // the report at runtime — which is exactly what happened when `language`
    // and `version` were first dropped. Pin the real read-set.
    const { catalog: projected } = boundGraphCatalog(catalog(2));

    for (const field of [
      'version', // contract identity
      'language', // graph-view-model projection
      'cacheKey', // provenance bar parses the engine mode out of it
      'builtAt', // provenance bar
      'resolutionMode', // provenance bar ("fast (approximate)")
      'features', // coupling view reads features.edge
      'functions', // every Explore view
    ]) {
      expect(projected, `the client reads '${field}'`).toHaveProperty(field);
    }
  });

  it('keeps only the feature map the coupling view reads', () => {
    const { catalog: projected } = boundGraphCatalog(catalog(3));
    const features = projected?.features as Record<string, unknown>;

    expect(Object.keys(features)).toEqual(['edge']);
    expect(features.edge).toEqual([{ from: 'a', to: 'b', weight: 1 }]);
  });

  it('strips per-occurrence fields the client contract does not declare', () => {
    const { catalog: projected } = boundGraphCatalog(catalog(1));
    const occ = (projected?.functions.h0000 ?? [])[0] ?? {};

    expect(occ.bodyHash).toBe('h0000');
    expect(occ.qualifiedName).toBe('pkg/mod#fn_h0000');
    for (const dropped of [
      'bodySize',
      'bodySignature',
      'enclosingClass',
      'decorators',
      'definedInGenerated',
    ]) {
      expect(occ, `${dropped} is storage-only and must not ship`).not.toHaveProperty(dropped);
    }
  });

  it('reports no omissions when everything fits', () => {
    const bounded = boundGraphCatalog(catalog(5));
    expect(bounded.totalFunctions).toBe(5);
    expect(bounded.omittedFunctions).toBe(0);
    expect(Object.keys(bounded.catalog?.functions ?? {})).toHaveLength(5);
  });

  it('bounds the catalog to the byte budget and reports what it dropped', () => {
    const bounded = boundGraphCatalog(catalog(200), 4000);

    expect(bounded.totalFunctions).toBe(200);
    expect(bounded.omittedFunctions).toBeGreaterThan(0);
    const kept = Object.keys(bounded.catalog?.functions ?? {}).length;
    expect(kept + bounded.omittedFunctions).toBe(200);
    expect(JSON.stringify(bounded.catalog).length).toBeLessThanOrEqual(4000);
  });

  it('keeps the highest-blast-radius functions when it must truncate', () => {
    // Function i has blast score i, so the last ones are the most important.
    const bounded = boundGraphCatalog(catalog(50, { blast: (i) => i }), 2000);
    const kept = Object.keys(bounded.catalog?.functions ?? {});

    expect(kept.length).toBeGreaterThan(0);
    expect(bounded.omittedFunctions).toBeGreaterThan(0);
    // h0049 has the highest blast score; h0000 the lowest.
    expect(kept).toContain('h0049');
    expect(kept).not.toContain('h0000');
  });

  it('truncates deterministically — the same catalog bounds identically twice', () => {
    const first = boundGraphCatalog(catalog(80, { blast: (i) => i % 7 }), 3000);
    const second = boundGraphCatalog(catalog(80, { blast: (i) => i % 7 }), 3000);

    expect(Object.keys(first.catalog?.functions ?? {})).toEqual(
      Object.keys(second.catalog?.functions ?? {}),
    );
    expect(first.omittedFunctions).toBe(second.omittedFunctions);
  });

  it('defaults to a budget that keeps a report shareable', () => {
    expect(MAX_GRAPH_CATALOG_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});
