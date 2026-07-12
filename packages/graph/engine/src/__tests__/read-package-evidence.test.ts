import { describe, expect, it } from 'vitest';

import { buildFeatures } from '../pipeline/features.js';
import { buildIndexes } from '../pipeline/indexes.js';
import { buildPackageEvidence } from '../read/package-evidence.js';
import { buildPackageScc } from '../read/package-scc.js';

import type {
  Catalog,
  DependencyClassification,
  DependencyEdge,
  FunctionOccurrence,
} from '../types.js';

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
    ...partial,
  };
}

function call(to: string, line = 2): NonNullable<FunctionOccurrence['calls']>[number] {
  return {
    to: [to],
    line,
    column: 3,
    resolution: 'static',
    confidence: 'high',
    text: 'target()',
  };
}

function dependency(
  to: readonly string[],
  specifier: string,
  line: number,
  classification?: DependencyClassification,
): DependencyEdge {
  return { to, specifier, line, column: 0, ...(classification && { classification }) };
}

/**
 * Build a persisted {@link DependencyClassification} for a to-`[]` declaration /
 * external / relative edge. Defaults `form`/`role` to a runtime import so tests
 * exercise the target-kind/basis/resolvedPackage attribution path directly.
 */
function cls(partial: Partial<DependencyClassification>): DependencyClassification {
  return {
    form: 'import-declaration',
    role: 'runtime',
    targetKind: 'catalog-source',
    basis: 'catalog-target',
    reason: 'test-classification',
    ...partial,
  };
}

function catalogOf(
  functions: Record<string, FunctionOccurrence[]>,
  partial: Partial<Catalog> = {},
): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-10T00:00:00.000Z',
    cacheKey: 'fixture',
    filesFingerprint: '0',
    resolutionMode: 'exact',
    functions,
    ...partial,
  };
}

function fixture(): Catalog {
  const moduleA = occurrence({
    bodyHash: 'module-a',
    simpleName: '<module-init:a>',
    qualifiedName: 'packages/a/src/index.ts',
    filePath: 'packages/a/src/index.ts',
    package: 'pkg-a',
    kind: 'module-init',
    dependencies: [
      dependency(['module-b'], './b.js', 1),
      dependency([], 'external-lib', 2),
      dependency(['missing-module'], `bad\0\u0085\u009F${'x'.repeat(600)}`, 3),
    ],
  });
  const moduleB = occurrence({
    bodyHash: 'module-b',
    simpleName: '<module-init:b>',
    qualifiedName: 'packages/b/src/index.ts',
    filePath: 'packages/b/src/index.ts',
    package: 'pkg-b',
    kind: 'module-init',
    dependencies: [dependency(['module-a'], './a.js', 1)],
  });
  return catalogOf({
    callerA: [
      occurrence({
        bodyHash: 'caller-a',
        simpleName: 'callerA',
        filePath: 'packages/a/src/caller.ts',
        package: 'pkg-a',
        calls: [call('target-b'), call('target-a', 3)],
      }),
    ],
    callerB: [
      occurrence({
        bodyHash: 'caller-b',
        simpleName: 'callerB',
        filePath: 'packages/b/src/caller.ts',
        package: 'pkg-b',
        calls: [call('target-a')],
      }),
    ],
    generatedCaller: [
      occurrence({
        bodyHash: 'generated-caller',
        simpleName: 'generatedCaller',
        filePath: 'generated/caller.ts',
        package: 'generated',
        definedInGenerated: true,
        calls: [call('target-a')],
      }),
    ],
    targetA: [
      occurrence({
        bodyHash: 'target-a',
        simpleName: 'targetA',
        filePath: 'packages/a/src/target.ts',
        package: 'pkg-a',
      }),
    ],
    targetB: [
      occurrence({
        bodyHash: 'target-b',
        simpleName: 'targetB',
        filePath: 'packages/b/src/target.ts',
        package: 'pkg-b',
      }),
    ],
    moduleA: [moduleA],
    moduleB: [moduleB],
  });
}

const productionFilter = {
  sourceScope: 'production' as const,
  generated: 'exclude' as const,
};

describe('buildPackageEvidence', () => {
  it('matches canonical FeatureTable package call rows and labels count units', () => {
    const catalog = fixture();
    const indexes = buildIndexes(catalog);
    const expected = buildFeatures(catalog, indexes, {}, ['packageCoupling']).edge;
    const result = buildPackageEvidence(catalog, indexes, {
      edgeKind: 'call',
      filter: productionFilter,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.calls.map((row) => ({
        callerPackage: row.fromPackage,
        calleePackage: row.toPackage,
        count: row.count,
      })),
    ).toEqual(expected);
    expect(result.value.calls.every((row) => row.countUnit === 'resolved-targets')).toBe(true);
    expect(result.value.calls.some((row) => row.fromPackage === 'generated')).toBe(false);
  });

  it('returns bounded concrete call evidence rather than only aggregate rows', () => {
    const catalog = fixture();
    const result = buildPackageEvidence(catalog, buildIndexes(catalog), {
      edgeKind: 'call',
      filter: productionFilter,
      fromPackage: 'pkg-a',
      toPackage: 'pkg-b',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalCallEvidence).toBe(1);
    expect(result.value.callEvidence).toEqual([
      expect.objectContaining({
        kind: 'call',
        fromPackage: 'pkg-a',
        toPackage: 'pkg-b',
        confidence: 'high',
        resolution: 'static',
        source: { file: 'packages/a/src/caller.ts', line: 2, column: 3 },
      }),
    ]);
  });

  it('deduplicates identical call proofs while preserving semantic variants and totals', () => {
    const exact = call('target');
    const catalog = catalogOf({
      caller: [
        occurrence({
          bodyHash: 'caller',
          simpleName: 'caller',
          filePath: 'packages/a/src/caller.ts',
          package: 'pkg-a',
          calls: [exact, { ...exact }, { ...exact, confidence: 'medium' }],
        }),
      ],
      target: [
        occurrence({
          bodyHash: 'target',
          simpleName: 'target',
          filePath: 'packages/b/src/target.ts',
          package: 'pkg-b',
        }),
      ],
    });
    const result = buildPackageEvidence(catalog, buildIndexes(catalog), {
      edgeKind: 'call',
      filter: productionFilter,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalCallEvidence).toBe(3);
    expect(result.value.callEvidence.map((row) => row.confidence)).toEqual(['high', 'medium']);
  });

  it('bounds call package-pair buckets during streaming', () => {
    const functions: Record<string, FunctionOccurrence[]> = {
      target: [
        occurrence({
          bodyHash: 'target',
          simpleName: 'target',
          filePath: 'packages/target/src/index.ts',
          package: 'target',
        }),
      ],
    };
    for (let index = 0; index < 10_001; index++) {
      const suffix = String(index).padStart(5, '0');
      functions[`caller${suffix}`] = [
        occurrence({
          bodyHash: `caller-${suffix}`,
          simpleName: `caller${suffix}`,
          filePath: `packages/pkg-${suffix}/src/index.ts`,
          package: `pkg-${suffix}`,
          calls: [call('target')],
        }),
      ];
    }
    const catalog = catalogOf(functions);
    const result = buildPackageEvidence(catalog, buildIndexes(catalog), {
      edgeKind: 'call',
      filter: productionFilter,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.calls).toHaveLength(10_000);
    expect(result.value.calls.at(-1)?.fromPackage).toBe('pkg-09999');
    expect(result.value.totalCallEvidence).toBe(10_001);
    expect(result.value.coverage.reasons).toContain('package-edge-group-cap');
  });

  it('keeps internal, external, and unresolved imports distinct and sanitizes specifiers', () => {
    const catalog = fixture();
    const result = buildPackageEvidence(catalog, buildIndexes(catalog), {
      edgeKind: 'import',
      filter: productionFilter,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imports.map((row) => row.resolution)).toEqual(
      expect.arrayContaining(['internal', 'external', 'unresolved']),
    );
    const unresolved = result.value.importEvidence.find((row) => row.resolution === 'unresolved');
    expect(unresolved?.specifier).not.toContain('\0');
    expect(unresolved?.specifier).not.toMatch(/[\u0085\u009F]/u);
    expect([...(unresolved?.specifier ?? '')]).toHaveLength(512);
    expect(result.value.coverage.reasons).toEqual(
      expect.arrayContaining(['specifier-sanitized', 'specifier-cap']),
    );
    expect(result.value.coverage.truncated).toBe(true);
    expect(result.value.imports.every((row) => row.countUnit === 'import-statements')).toBe(true);
  });

  it('resolves empty-target imports from the persisted classification', () => {
    // A `.d.ts` declaration entry that global-merge attributed to a unique
    // workspace package resolves internal on its persisted resolvedPackage —
    // NOT by re-inferring a package from the specifier's leaf name.
    const catalog = catalogOf({
      moduleA: [
        occurrence({
          bodyHash: 'module-a',
          simpleName: '<module-init:a>',
          filePath: 'packages/a/src/index.ts',
          package: 'pkg-a',
          kind: 'module-init',
          dependencies: [
            dependency([], './missing.js', 1, cls({ targetKind: 'unresolved', basis: 'unresolved', reason: 'relative-target-unresolved' })),
            dependency([], '@scope/pkg-b', 2, cls({ targetKind: 'declaration-file', basis: 'workspace-manifest', reason: 'workspace-declaration-entry', resolvedPackage: 'pkg-b' })),
            dependency([], 'clearly-external', 3, cls({ targetKind: 'external', basis: 'external-specifier', reason: 'external-package' })),
          ],
        }),
      ],
      moduleB: [
        occurrence({
          bodyHash: 'module-b',
          simpleName: '<module-init:b>',
          filePath: 'packages/b/src/index.ts',
          package: 'pkg-b',
          kind: 'module-init',
          dependencies: [],
        }),
      ],
    });
    const result = buildPackageEvidence(catalog, buildIndexes(catalog), {
      edgeKind: 'import',
      filter: productionFilter,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Aggregated rows key by resolved `target`: unresolved/external keep the
    // specifier; the workspace declaration resolves to its `resolvedPackage`.
    const byTarget = Object.fromEntries(result.value.imports.map((row) => [row.target, row]));
    expect(byTarget['./missing.js']?.resolution).toBe('unresolved');
    expect(byTarget['clearly-external']?.resolution).toBe('external');
    expect(byTarget['pkg-b']?.resolution).toBe('internal');
    expect(byTarget['pkg-b']?.toPackage).toBe('pkg-b');
    // Concrete evidence samples carry the persisted classification + confidence.
    const workspaceEvidence = result.value.importEvidence.find(
      (row) => row.specifier === '@scope/pkg-b',
    );
    expect(workspaceEvidence?.resolution).toBe('internal');
    expect(workspaceEvidence?.confidence).toBe('high');
    expect(workspaceEvidence?.classification?.basis).toBe('workspace-manifest');
    expect(workspaceEvidence?.classification?.resolvedPackage).toBe('pkg-b');
  });

  it('carries form/role and resolves subpath, type-only, and re-export declarations', () => {
    // Root and subpath declaration entries both resolve on their persisted
    // resolvedPackage; an undeclared subpath fails closed; type-only imports and
    // re-exports preserve their form/role while still resolving internally.
    const catalog = catalogOf({
      moduleA: [
        occurrence({
          bodyHash: 'module-a',
          simpleName: '<module-init:a>',
          filePath: 'packages/a/src/index.ts',
          package: 'pkg-a',
          kind: 'module-init',
          dependencies: [
            dependency([], '@scope/pkg-b/sub', 1, cls({ targetKind: 'declaration-file', basis: 'workspace-manifest', reason: 'workspace-subpath-declaration-entry', resolvedPackage: 'pkg-b' })),
            dependency([], '@scope/pkg-b/undeclared', 2, cls({ targetKind: 'unresolved', basis: 'unresolved', reason: 'undeclared-exports-subpath' })),
            dependency([], '@scope/pkg-b', 3, cls({ form: 'import-declaration', role: 'type-only', targetKind: 'declaration-file', basis: 'workspace-manifest', reason: 'workspace-declaration-entry', resolvedPackage: 'pkg-b' })),
            dependency([], '@scope/pkg-c', 4, cls({ form: 're-export', role: 'runtime', targetKind: 'declaration-file', basis: 'workspace-manifest', reason: 'workspace-declaration-entry', resolvedPackage: 'pkg-c' })),
          ],
        }),
      ],
    });
    const result = buildPackageEvidence(catalog, buildIndexes(catalog), {
      edgeKind: 'import',
      filter: productionFilter,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byTarget = Object.fromEntries(result.value.imports.map((row) => [row.target, row]));
    // The subpath and the type-only import both attribute to pkg-b (one row).
    expect(byTarget['pkg-b']?.resolution).toBe('internal');
    expect(byTarget['pkg-c']?.resolution).toBe('internal');
    expect(byTarget['@scope/pkg-b/undeclared']?.resolution).toBe('unresolved');
    const bySpecifier = Object.fromEntries(
      result.value.importEvidence.map((row) => [row.specifier, row]),
    );
    expect(bySpecifier['@scope/pkg-b']?.classification?.role).toBe('type-only');
    expect(bySpecifier['@scope/pkg-c']?.classification?.form).toBe('re-export');
    expect(bySpecifier['@scope/pkg-b/sub']?.classification?.reason).toBe(
      'workspace-subpath-declaration-entry',
    );
  });

  it('does not fan a colliding module body hash into invented package edges', () => {
    const catalog = catalogOf({
      source: [
        occurrence({
          bodyHash: 'source',
          simpleName: '<module-init:source>',
          filePath: 'packages/a/src/index.ts',
          package: 'pkg-a',
          kind: 'module-init',
          dependencies: [dependency(['shared-module'], '@scope/ambiguous', 1)],
        }),
      ],
      targetB: [
        occurrence({
          bodyHash: 'shared-module',
          simpleName: '<module-init:b>',
          filePath: 'packages/b/src/index.ts',
          package: 'pkg-b',
          kind: 'module-init',
          dependencies: [],
        }),
      ],
      targetC: [
        occurrence({
          bodyHash: 'shared-module',
          simpleName: '<module-init:c>',
          filePath: 'packages/c/src/index.ts',
          package: 'pkg-c',
          kind: 'module-init',
          dependencies: [],
        }),
      ],
    });
    const result = buildPackageEvidence(catalog, buildIndexes(catalog), {
      edgeKind: 'import',
      filter: productionFilter,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imports).toEqual([
      expect.objectContaining({
        fromPackage: 'pkg-a',
        toPackage: null,
        target: '@scope/ambiguous',
        resolution: 'unresolved',
      }),
    ]);
    expect(result.value.coverage.reasons).toContain('ambiguous-import-target');
  });

  it('fails a colliding multi-package body twin closed to unresolved', () => {
    // A bare-specifier import whose target body hash exists in two packages is
    // ambiguous — the removed leaf-name path would have invented an edge to the
    // package matching the specifier's leaf. It now fails closed to unresolved.
    const catalog = catalogOf({
      source: [
        occurrence({
          bodyHash: 'source',
          simpleName: '<module-init:source>',
          filePath: 'packages/a/src/index.ts',
          package: 'pkg-a',
          kind: 'module-init',
          dependencies: [dependency(['shared-module'], '@scope/pkg-b', 1)],
        }),
      ],
      scopedTarget: [
        occurrence({
          bodyHash: 'shared-module',
          simpleName: '<module-init:scoped>',
          filePath: 'packages/scoped/src/index.ts',
          package: '@scope/pkg-b',
          kind: 'module-init',
          dependencies: [],
        }),
      ],
      legacyTarget: [
        occurrence({
          bodyHash: 'shared-module',
          simpleName: '<module-init:legacy>',
          filePath: 'packages/legacy/src/index.ts',
          package: 'pkg-b',
          kind: 'module-init',
          dependencies: [],
        }),
      ],
    });
    const result = buildPackageEvidence(catalog, buildIndexes(catalog), {
      edgeKind: 'import',
      filter: productionFilter,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imports).toEqual([
      expect.objectContaining({
        fromPackage: 'pkg-a',
        toPackage: null,
        target: '@scope/pkg-b',
        resolution: 'unresolved',
      }),
    ]);
  });

  it('omits malformed dependency target identities with partial coverage', () => {
    const malformed = dependency(['bad\u0085target'], './target.js', 1);
    const catalog = catalogOf({
      source: [
        occurrence({
          bodyHash: 'source',
          simpleName: '<module-init:source>',
          filePath: 'src/index.ts',
          kind: 'module-init',
          dependencies: [malformed],
        }),
      ],
    });
    const result = buildPackageEvidence(catalog, buildIndexes(catalog), {
      edgeKind: 'import',
      filter: productionFilter,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imports).toEqual([]);
    expect(result.value.coverage).toEqual({
      complete: false,
      truncated: false,
      reasons: ['malformed-import-evidence-omitted'],
    });
  });

  it('reports partial import coverage for absent dependencies and fast catalogs', () => {
    const noDependencies = catalogOf({
      module: [
        occurrence({
          bodyHash: 'module',
          simpleName: '<module-init>',
          filePath: 'src/index.ts',
          kind: 'module-init',
        }),
      ],
    });
    const absent = buildPackageEvidence(noDependencies, buildIndexes(noDependencies), {
      edgeKind: 'import',
      filter: productionFilter,
    });
    expect(absent.ok && absent.value.coverage.reasons).toContain('dependency-edges-unavailable');
    expect(absent.ok && absent.value.coverage).toMatchObject({
      complete: false,
      truncated: false,
    });

    const fast = { ...noDependencies, resolutionMode: 'fast' as const };
    const approximate = buildPackageEvidence(fast, buildIndexes(fast), {
      edgeKind: 'combined',
      filter: productionFilter,
    });
    expect(approximate.ok && approximate.value.coverage.reasons).toEqual(
      expect.arrayContaining(['fast-resolution-approximate', 'fast-import-coverage-partial']),
    );
    expect(approximate.ok && approximate.value.coverage.truncated).toBe(false);
  });

  it('reports control sanitization as partial without claiming hard truncation', () => {
    const catalog = catalogOf({
      module: [
        occurrence({
          bodyHash: 'module',
          simpleName: '<module-init>',
          filePath: 'src/index.ts',
          kind: 'module-init',
          dependencies: [dependency([], 'safe\u0085name', 1)],
        }),
      ],
    });
    const result = buildPackageEvidence(catalog, buildIndexes(catalog), {
      edgeKind: 'import',
      filter: productionFilter,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.importEvidence[0]?.specifier).toBe('safename');
    expect(result.value.coverage).toEqual({
      complete: false,
      truncated: false,
      reasons: ['specifier-sanitized'],
    });
  });

  it('bounds import specifiers by Unicode code points', () => {
    const catalog = catalogOf({
      module: [
        occurrence({
          bodyHash: 'module',
          simpleName: '<module-init>',
          filePath: 'src/index.ts',
          kind: 'module-init',
          dependencies: [dependency([], '\u{1F600}'.repeat(600), 1)],
        }),
      ],
    });
    const result = buildPackageEvidence(catalog, buildIndexes(catalog), {
      edgeKind: 'import',
      filter: productionFilter,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...(result.value.importEvidence[0]?.specifier ?? '')]).toHaveLength(512);
    expect(result.value.coverage.reasons).toEqual(['specifier-cap']);
    expect(result.value.coverage.truncated).toBe(true);
  });

  it('bounds import package-target buckets during streaming', () => {
    const dependencies = Array.from({ length: 10_001 }, (_, index) => {
      const suffix = String(index).padStart(5, '0');
      return dependency([], `external-${suffix}`, index + 1);
    });
    const catalog = catalogOf({
      module: [
        occurrence({
          bodyHash: 'module',
          simpleName: '<module-init>',
          filePath: 'src/index.ts',
          package: 'pkg',
          kind: 'module-init',
          dependencies,
        }),
      ],
    });
    const result = buildPackageEvidence(catalog, buildIndexes(catalog), {
      edgeKind: 'import',
      filter: productionFilter,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imports).toHaveLength(10_000);
    expect(result.value.imports.at(-1)?.target).toBe('external-09999');
    expect(result.value.totalImportEvidence).toBe(10_001);
    expect(result.value.coverage.reasons).toContain('package-edge-group-cap');
  });

  it('uses canonical packages for legacy occurrences without a package stamp', () => {
    const catalog = catalogOf({
      caller: [
        occurrence({
          bodyHash: 'caller',
          simpleName: 'caller',
          filePath: 'packages/alpha/src/caller.ts',
          calls: [call('target')],
        }),
      ],
      target: [
        occurrence({
          bodyHash: 'target',
          simpleName: 'target',
          filePath: 'packages/beta/src/target.ts',
        }),
      ],
    });
    const result = buildPackageEvidence(catalog, buildIndexes(catalog), {
      edgeKind: 'call',
      filter: productionFilter,
    });
    expect(result.ok && result.value.calls[0]).toMatchObject({
      fromPackage: 'alpha',
      toPackage: 'beta',
    });
  });
});

describe('buildPackageScc', () => {
  it('finds deterministic multi-package call/import cycles with labelled proofs', () => {
    const catalog = fixture();
    const callCycles = buildPackageScc(catalog, buildIndexes(catalog), {
      edgeKind: 'call',
      filter: productionFilter,
    });
    expect(callCycles.ok).toBe(true);
    if (!callCycles.ok) return;
    expect(callCycles.value.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packages: ['pkg-a', 'pkg-b'],
          proofEdges: expect.arrayContaining([
            expect.objectContaining({
              kind: 'call',
              from: 'pkg-a',
              to: 'pkg-b',
            }),
            expect.objectContaining({
              kind: 'call',
              from: 'pkg-b',
              to: 'pkg-a',
            }),
          ]),
        }),
      ]),
    );
    // No returned component is a singleton, and no proof edge is a self edge.
    for (const component of callCycles.value.components) {
      expect(component.packages.length).toBeGreaterThanOrEqual(2);
      for (const edge of component.proofEdges) expect(edge.from).not.toBe(edge.to);
    }

    const importCycles = buildPackageScc(catalog, buildIndexes(catalog), {
      edgeKind: 'import',
      filter: productionFilter,
    });
    expect(importCycles.ok && importCycles.value.components[0]).toMatchObject({
      packages: ['pkg-a', 'pkg-b'],
    });
    expect(
      importCycles.ok &&
        importCycles.value.components[0]?.proofEdges.every((edge) => edge.kind === 'import'),
    ).toBe(true);
  });

  it('returns no components for a self-edges-only graph (P2 Phase 1.1)', () => {
    // Two packages, each with ONLY intra-package edges — a package depending on
    // itself is not a package cycle, so no SCC is returned.
    const catalog = catalogOf({
      aOne: [occurrence({ bodyHash: 'a1', simpleName: 'a1', filePath: 'packages/a/src/one.ts', package: 'pkg-a', calls: [call('a2')] })],
      aTwo: [occurrence({ bodyHash: 'a2', simpleName: 'a2', filePath: 'packages/a/src/two.ts', package: 'pkg-a', calls: [call('a1')] })],
      bOne: [occurrence({ bodyHash: 'b1', simpleName: 'b1', filePath: 'packages/b/src/one.ts', package: 'pkg-b', calls: [call('b2')] })],
      bTwo: [occurrence({ bodyHash: 'b2', simpleName: 'b2', filePath: 'packages/b/src/two.ts', package: 'pkg-b', calls: [call('b1')] })],
    });
    for (const edgeKind of ['call', 'import', 'combined'] as const) {
      const result = buildPackageScc(catalog, buildIndexes(catalog), { edgeKind, filter: productionFilter });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.components).toEqual([]);
    }
  });

  it('preserves both call and import proof kinds for a combined multi-package cycle', () => {
    const combined = buildPackageScc(fixture(), buildIndexes(fixture()), {
      edgeKind: 'combined',
      filter: productionFilter,
    });
    expect(combined.ok).toBe(true);
    if (!combined.ok) return;
    const cycle = combined.value.components.find((c) => c.packages.join(',') === 'pkg-a,pkg-b');
    expect(cycle).toBeDefined();
    const kinds = new Set(cycle?.proofEdges.map((e) => e.kind));
    expect(kinds.has('call')).toBe(true);
    expect(kinds.has('import')).toBe(true);
  });

  it('caps proving edges independently and propagates partial coverage', () => {
    const packageNames = Array.from({ length: 8 }, (_, index) => `pkg-${String(index)}`);
    const functions: Record<string, FunctionOccurrence[]> = {};
    for (const [index, packageName] of packageNames.entries()) {
      functions[`node${String(index)}`] = [
        occurrence({
          bodyHash: `h-${String(index)}`,
          simpleName: `node${String(index)}`,
          filePath: `packages/${packageName}/src/index.ts`,
          package: packageName,
          calls: packageNames.map((_target, targetIndex) => call(`h-${String(targetIndex)}`)),
        }),
      ];
    }
    const catalog = catalogOf(functions);
    const result = buildPackageScc(catalog, buildIndexes(catalog), {
      edgeKind: 'call',
      filter: productionFilter,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 8 packages each call all 8 targets; the 8 self edges are excluded from the
    // SCC (P2 Phase 1.1), leaving 8x7 = 56 cross-package proof edges.
    expect(result.value.components[0]?.totalProofEdges).toBe(56);
    expect(result.value.components[0]?.proofEdges).toHaveLength(50);
    expect(result.value.coverage).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(result.value.coverage.reasons).toContain('proof-edge-cap');
  });
});
