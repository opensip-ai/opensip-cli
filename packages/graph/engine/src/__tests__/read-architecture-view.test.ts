import { describe, expect, it } from 'vitest';

import { compareCodePointStrings, continuationToken } from '../code-point-order.js';
import { buildIndexes } from '../pipeline/indexes.js';
import {
  boundedArchitectureRows,
  buildArchitectureView,
  hotspotStableKey,
  packageEdgeStableKey,
} from '../read/architecture-view.js';
import { type SourceRoleMatcher } from '../read/index.js';
import { type GraphSourceFilter } from '../read/query-contracts.js';

import type { Catalog, FunctionOccurrence } from '../types.js';

const noMatcher: SourceRoleMatcher = { matches: () => false };

function reversed<T>(values: readonly T[]): T[] {
  return values.reduceRight<T[]>((output, value) => {
    output.push(value);
    return output;
  }, []);
}

function occ(
  partial: Partial<FunctionOccurrence> &
    Pick<FunctionOccurrence, 'bodyHash' | 'simpleName' | 'filePath'>,
): FunctionOccurrence {
  return {
    qualifiedName: partial.simpleName,
    line: 1,
    column: 0,
    endLine: 10,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    package: 'pkg-a',
    ...partial,
  };
}

function makeCatalog(): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-09T00:00:00.000Z',
    cacheKey: 'test',
    filesFingerprint: '0',
    resolutionMode: 'exact',
    engineMode: 'exact',
    functions: {
      caller: [
        occ({
          bodyHash: 'h-caller',
          simpleName: 'caller',
          filePath: 'src/a/caller.ts',
          package: 'pkg-a',
          calls: [
            {
              to: ['h-target'],
              line: 3,
              column: 2,
              resolution: 'static',
              confidence: 'high',
              text: 'target()',
            },
            {
              to: [],
              line: 4,
              column: 2,
              resolution: 'unknown',
              confidence: 'low',
              text: 'maybe()',
            },
            {
              to: [],
              line: 4,
              column: 2,
              resolution: 'unknown',
              confidence: 'low',
              text: 'duplicate persisted maybe()',
            },
          ],
        }),
      ],
      target: [
        occ({
          bodyHash: 'h-target',
          simpleName: 'target',
          filePath: 'src/b/target.ts',
          package: 'pkg-b',
        }),
      ],
      // Same body as target twin in another package
      targetTwin: [
        occ({
          bodyHash: 'h-target',
          simpleName: 'targetTwin',
          filePath: 'src/c/twin.ts',
          package: 'pkg-c',
          line: 2,
        }),
      ],
      testOnly: [
        occ({
          bodyHash: 'h-test',
          simpleName: 'testOnly',
          filePath: 'src/a/caller.test.ts',
          package: 'pkg-a',
          inTestFile: true,
        }),
      ],
      generated: [
        occ({
          bodyHash: 'h-gen',
          simpleName: 'generated',
          filePath: 'gen/x.ts',
          package: 'gen',
          definedInGenerated: true,
        }),
      ],
    },
  };
}

const ALL_SECTIONS = ['metrics', 'packageEdges', 'hotspots'] as const;

function view(filter: GraphSourceFilter, limit = 25) {
  const catalog = makeCatalog();
  const indexes = buildIndexes(catalog);
  // Tests that exercise ranked families request them explicitly (P2 Phase 2.5
  // defaults to metrics-only).
  return buildArchitectureView(
    catalog,
    indexes,
    {
      filter,
      limit,
      sections: ALL_SECTIONS,
      topN: 100,
    },
    noMatcher,
  );
}

describe('buildArchitectureView', () => {
  it('defaults: production/non-generated separates occurrence vs unique-body counts', () => {
    const result = view({ sourceScope: 'production', generated: 'exclude' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v = result.value;
    // caller, target, targetTwin (test + generated excluded)
    expect(v.occurrenceCount.value).toBe(3);
    expect(v.occurrenceCount.nodeIdentity).toBe('occurrence');
    expect(v.occurrenceCount.sourceScope).toBe('production');
    expect(v.occurrenceCount.generated).toBe('exclude');
    // h-caller + h-target (twins share body)
    expect(v.uniqueBodyCount.value).toBe(2);
    expect(v.uniqueBodyCount.nodeIdentity).toBe('body-hash');
    expect(v.languages).toEqual(['typescript']);
  });

  it('reports call confidence/resolution distributions with labels', () => {
    const result = view({ sourceScope: 'production', generated: 'exclude' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ce = result.value.callEvidence;
    expect(ce.edgeKind).toBe('call');
    expect(ce.catalogResolutionMode).toBe('exact');
    expect(ce.resolvedCallSites).toBeGreaterThanOrEqual(1);
    expect(ce.resolvedTargets).toBeGreaterThanOrEqual(1);
    expect(ce.unresolvedCallSites).toBe(1);
    expect(ce.confidence.high).toBeGreaterThanOrEqual(1);
    expect(ce.resolution.static).toBeGreaterThanOrEqual(1);
    expect(ce.distributionCountUnit).toBe('resolved-targets-plus-unresolved-call-sites');
    expect(ce.resolvedTargetConfidence.countUnit).toBe('resolved-targets');
    expect(ce.unresolvedCallSiteConfidence.countUnit).toBe('unresolved-call-sites');
    expect(ce.unresolvedCallSiteConfidence.values).toEqual({ low: 1 });
    expect(ce.unresolvedCallSiteResolution.values).toEqual({ unknown: 1 });
    expect(ce.nodeIdentity).toBe('occurrence');
    expect(ce.sourceScope).toBe('production');
    expect(ce.generated).toBe('exclude');
  });

  it('returns package edges (not only degree) for production default', () => {
    const result = view({ sourceScope: 'production', generated: 'exclude' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packageCount.value).toBeGreaterThanOrEqual(2);
    expect(result.value.packageCount).toMatchObject({
      nodeIdentity: 'package',
      sourceScope: 'production',
      generated: 'exclude',
    });
    expect(result.value.packageEdges.length).toBeGreaterThanOrEqual(1);
    const edge = result.value.packageEdges.find(
      (e) => e.fromPackage === 'pkg-a' && e.toPackage === 'pkg-b',
    );
    expect(edge).toBeDefined();
    expect(edge?.kind).toBe('call');
    expect(edge?.countUnit).toBe('resolved-targets');
    expect(edge).toMatchObject({
      nodeIdentity: 'package',
      sourceScope: 'production',
      generated: 'exclude',
      catalogResolutionMode: 'exact',
    });
    expect((edge?.count ?? 0) > 0).toBe(true);
  });

  it('filters hotspots before ranking and labels twin identity', () => {
    const result = view({ sourceScope: 'production', generated: 'exclude' }, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const h of result.value.hotspots) {
      expect(h.identityMode).toBe('body-twin-union');
      expect(h.symbol.inTestFile).toBe(false);
      expect(h.symbol.definedInGenerated).toBe(false);
      if (h.symbol.bodyHash === 'h-target') {
        expect(h.twinCount).toBe(2);
        expect(h.matchingTwinCount).toBe(2);
      }
    }
  });

  it('opt-in test and generated scopes change counts', () => {
    const tests = view({ sourceScope: 'test', generated: 'include' });
    expect(tests.ok && tests.value.occurrenceCount.value).toBe(1);

    const gen = view({ sourceScope: 'all', generated: 'only' });
    expect(gen.ok && gen.value.occurrenceCount.value).toBe(1);

    const all = view({ sourceScope: 'all', generated: 'include' });
    expect(all.ok && all.value.occurrenceCount.value).toBe(5);
  });

  it('exact-file and prefix filters restrict package/occurrence evidence', () => {
    const exact = view({
      sourceScope: 'all',
      generated: 'include',
      filePath: 'src/a/caller.ts',
    });
    expect(exact.ok && exact.value.occurrenceCount.value).toBe(1);

    const prefix = view({
      sourceScope: 'production',
      generated: 'exclude',
      filePrefix: 'src/b',
    });
    expect(prefix.ok && prefix.value.occurrenceCount.value).toBe(1);
  });

  it('echoes effective filter and exact/fast catalog mode label', () => {
    const filter: GraphSourceFilter = {
      sourceScope: 'production',
      generated: 'exclude',
      packages: ['pkg-a'],
    };
    const result = view(filter);
    expect(result.ok && result.value.effectiveFilter).toEqual(filter);
    expect(result.ok && result.value.callEvidence.catalogResolutionMode).toBe('exact');
  });

  it('omits malformed rows and call edges from metrics with partial coverage', () => {
    const catalog = makeCatalog();
    const caller = catalog.functions.caller?.[0];
    if (caller === undefined) throw new Error('caller fixture missing');
    const malformedCall = {
      to: ['h-target'],
      line: 8,
      column: 0,
      resolution: 'invented',
      confidence: 'certain',
      text: 'bad()',
    } as unknown as NonNullable<FunctionOccurrence['calls']>[number];
    const malformedCatalog: Catalog = {
      ...catalog,
      functions: {
        ...catalog.functions,
        caller: [{ ...caller, calls: [...caller.calls, malformedCall] }],
        malformed: [
          occ({
            bodyHash: 'h-malformed',
            simpleName: 'malformed',
            filePath: 'src/bad.ts',
            package: 'bad',
            line: 0,
            calls: [
              {
                to: ['h-target'],
                line: 2,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'target()',
              },
            ],
          }),
        ],
      },
    };
    const result = buildArchitectureView(malformedCatalog, buildIndexes(malformedCatalog), {
      filter: {
        packages: ['pkg-a', 'pkg-b', 'pkg-c', 'gen', 'bad'],
        sourceScope: 'all',
        generated: 'include',
      },
      limit: 25,
      sections: ALL_SECTIONS,
      topN: 100,
    }, noMatcher);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.occurrenceCount.value).toBe(5);
    expect(result.value.packageCount.value).toBe(4);
    expect(result.value.packageEdges).not.toContainEqual(
      expect.objectContaining({ fromPackage: 'bad' }),
    );
    expect(result.value.callEvidence.resolvedTargets).toBe(1);
    expect(result.value.coverage).toEqual({
      complete: false,
      truncated: false,
      reasons: ['malformed-call-edge-omitted', 'malformed-symbol-omitted'],
    });
  });

  it('counts a prototype-named resolution label as data and drops unreachable ones upstream (P2 Phase 1.2)', () => {
    const call = (
      resolution: string,
      line: number,
    ): NonNullable<FunctionOccurrence['calls']>[number] =>
      ({
        // Resolve to a clean, twin-free target so the resolved edge stays in
        // scope (h-target has a pkg-c body twin the filter would drop).
        to: ['h-clean'],
        line,
        column: 0,
        resolution,
        confidence: 'high',
        text: 'x()',
      }) as unknown as NonNullable<FunctionOccurrence['calls']>[number];

    const base = makeCatalog();
    const catalog: Catalog = {
      ...base,
      functions: {
        ...base.functions,
        caller: [
          occ({
            bodyHash: 'h-caller',
            simpleName: 'caller',
            filePath: 'src/a/caller.ts',
            package: 'pkg-a',
            // `constructor` is a VALID call resolution (occurrence-call-graph
            // enum) that is also a prototype key — the reachable hostile case.
            // `__proto__` is NOT a valid resolution, so it is dropped upstream as
            // a malformed edge and never reaches the counter (layered defense).
            calls: [call('constructor', 3), call('constructor', 5), call('static', 7), call('__proto__', 9)],
          }),
        ],
        cleanTarget: [
          occ({
            bodyHash: 'h-clean',
            simpleName: 'cleanTarget',
            filePath: 'src/b/clean.ts',
            package: 'pkg-b',
          }),
        ],
      },
    };

    const result = buildArchitectureView(catalog, buildIndexes(catalog), {
      filter: { packages: ['pkg-a', 'pkg-b'], sourceScope: 'all', generated: 'include' },
      limit: 25,
      sections: ALL_SECTIONS,
      topN: 100,
    }, noMatcher);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ce = result.value.callEvidence;

    // The old plain-object counter read Object.prototype.constructor (a function)
    // and string-concatenated it; the Map-based counter treats it as pure data.
    expect(ce.resolution.constructor).toBe(2);
    expect(typeof ce.resolution.constructor).toBe('number');
    expect(ce.resolvedTargetResolution.values.constructor).toBe(2);
    expect(ce.resolution.static).toBe(1);
    // The invalid `__proto__` resolution is dropped upstream as malformed — it
    // never reaches the counter and never becomes a key.
    expect(Object.hasOwn(ce.resolution, '__proto__')).toBe(false);
    expect(result.value.coverage.reasons).toContain('malformed-call-edge-omitted');
    // Every DTO record is a plain, prototype-intact object; no global pollution.
    for (const record of [ce.resolution, ce.confidence, ce.resolvedTargetResolution.values]) {
      expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    }
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('pages package edges and hotspots independently without repeating completed rows', () => {
    const catalog = makeCatalog();
    const indexes = buildIndexes(catalog);
    const filter: GraphSourceFilter = { sourceScope: 'production', generated: 'exclude' };
    const first = buildArchitectureView(catalog, indexes, { filter, limit: 1, sections: ALL_SECTIONS, topN: 100 }, noMatcher);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const packageKey = first.value.packageEdges[0];
    const hotspotKey = first.value.hotspots[0];
    expect(packageKey).toBeDefined();
    expect(hotspotKey).toBeDefined();
    if (packageKey === undefined || hotspotKey === undefined) return;

    const second = buildArchitectureView(catalog, indexes, {
      filter,
      limit: 1,
      sections: ALL_SECTIONS,
      topN: 100,
      afterPackageEdgeKey: continuationToken(packageEdgeStableKey(packageKey)),
      afterHotspotKey: continuationToken(hotspotStableKey(hotspotKey)),
      packageEdgesDone: !first.value.packageEdgesHasMore,
      hotspotsDone: !first.value.hotspotsHasMore,
    }, noMatcher);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    if (!first.value.packageEdgesHasMore) expect(second.value.packageEdges).toEqual([]);
    if (!first.value.hotspotsHasMore) expect(second.value.hotspots).toEqual([]);
    expect(second.value.packageEdges).not.toContainEqual(packageKey);
    expect(second.value.hotspots).not.toContainEqual(hotspotKey);
  });

  it('computes group summaries over the full filtered orientation set, not one page', () => {
    const catalog = makeCatalog();
    const result = buildArchitectureView(catalog, buildIndexes(catalog), {
      filter: { sourceScope: 'production', generated: 'exclude' },
      limit: 1,
      groupBy: 'file',
      sections: ALL_SECTIONS,
      topN: 100,
    }, noMatcher);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hotspots).toHaveLength(1);
    expect((result.value.groups?.length ?? 0) > result.value.hotspots.length).toBe(true);
  });

  it('keeps the actual deterministic top rows when candidates exceed the hard cap', () => {
    const cap = 10_000;
    const rows = Array.from({ length: cap + 1 }, (_, index) => ({
      fromPackage: `pkg-${String(index).padStart(5, '0')}`,
      toPackage: 'target',
      kind: 'call' as const,
      count: index === cap ? 99 : 1,
      countUnit: 'resolved-targets' as const,
      nodeIdentity: 'package' as const,
      sourceScope: 'production' as const,
      generated: 'exclude' as const,
      catalogResolutionMode: 'exact' as const,
    }));
    const compare = (left: (typeof rows)[number], right: (typeof rows)[number]) =>
      compareCodePointStrings(packageEdgeStableKey(left), packageEdgeStableKey(right));
    const forward = boundedArchitectureRows(rows, cap, compare);
    const reverse = boundedArchitectureRows(reversed(rows), cap, compare);
    expect(forward.truncated).toBe(true);
    expect(forward.rows).toEqual(reverse.rows);
    expect(forward.rows[0]?.count).toBe(99);
    expect(forward.rows).toHaveLength(cap);
  });

  it('chooses the same twin hotspot representative regardless of catalog insertion order', () => {
    const forwardCatalog = makeCatalog();
    const reverseCatalog: Catalog = {
      ...forwardCatalog,
      functions: Object.fromEntries(reversed(Object.entries(forwardCatalog.functions))),
    };
    const filter: GraphSourceFilter = { sourceScope: 'production', generated: 'exclude' };
    const forward = buildArchitectureView(forwardCatalog, buildIndexes(forwardCatalog), {
      filter,
      limit: 25,
      sections: ALL_SECTIONS,
      topN: 100,
    }, noMatcher);
    const reverse = buildArchitectureView(reverseCatalog, buildIndexes(reverseCatalog), {
      filter,
      limit: 25,
      sections: ALL_SECTIONS,
      topN: 100,
    }, noMatcher);
    expect(forward.ok).toBe(true);
    expect(reverse.ok).toBe(true);
    if (!forward.ok || !reverse.ok) return;
    expect(
      forward.value.hotspots.find((row) => row.symbol.bodyHash === 'h-target')?.symbol.symbolId,
    ).toBe('src/b/target.ts:1:0');
    expect(reverse.value.hotspots).toEqual(forward.value.hotspots);
  });
});
