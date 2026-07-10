import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../pipeline/indexes.js';
import { buildArchitectureView } from '../read/architecture-view.js';
import { type GraphSourceFilter } from '../read/query-contracts.js';

import type { Catalog, FunctionOccurrence } from '../types.js';

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

function view(filter: GraphSourceFilter, limit = 25) {
  const catalog = makeCatalog();
  const indexes = buildIndexes(catalog);
  return buildArchitectureView(catalog, indexes, { filter, limit });
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
    expect(ce.unresolvedCallSites).toBeGreaterThanOrEqual(1);
    expect(ce.confidence.high).toBeGreaterThanOrEqual(1);
    expect(ce.resolution.static).toBeGreaterThanOrEqual(1);
  });

  it('returns package edges (not only degree) for production default', () => {
    const result = view({ sourceScope: 'production', generated: 'exclude' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packageCount).toBeGreaterThanOrEqual(2);
    expect(result.value.packageEdges.length).toBeGreaterThanOrEqual(1);
    const edge = result.value.packageEdges.find(
      (e) => e.fromPackage === 'pkg-a' && e.toPackage === 'pkg-b',
    );
    expect(edge).toBeDefined();
    expect(edge?.kind).toBe('call');
    expect(edge?.countUnit).toBe('call-sites');
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
});
