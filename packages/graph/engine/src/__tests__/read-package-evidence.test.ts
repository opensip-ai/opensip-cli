import { describe, expect, it } from 'vitest';

import { buildFeatures } from '../pipeline/features.js';
import { buildIndexes } from '../pipeline/indexes.js';
import { buildPackageEvidence } from '../read/package-evidence.js';
import { buildPackageScc } from '../read/package-scc.js';

import type { Catalog, DependencyEdge, FunctionOccurrence } from '../types.js';

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

function dependency(to: readonly string[], specifier: string, line: number): DependencyEdge {
  return { to, specifier, line, column: 0 };
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

  it('classifies empty relative and known-workspace targets as unresolved', () => {
    const catalog = catalogOf({
      moduleA: [
        occurrence({
          bodyHash: 'module-a',
          simpleName: '<module-init:a>',
          filePath: 'packages/a/src/index.ts',
          package: 'pkg-a',
          kind: 'module-init',
          dependencies: [
            dependency([], './missing.js', 1),
            dependency([], '@scope/pkg-b', 2),
            dependency([], 'clearly-external', 3),
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
    expect(
      Object.fromEntries(result.value.imports.map((row) => [row.target, row.resolution])),
    ).toMatchObject({
      './missing.js': 'unresolved',
      '@scope/pkg-b': 'unresolved',
      'clearly-external': 'external',
    });
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

  it('prefers an exact scoped package over a colliding legacy leaf name', () => {
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
        toPackage: '@scope/pkg-b',
        target: '@scope/pkg-b',
        resolution: 'internal',
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
  it('finds deterministic call/import self and multi-package cycles with labelled proofs', () => {
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
    expect(result.value.components[0]?.totalProofEdges).toBe(64);
    expect(result.value.components[0]?.proofEdges).toHaveLength(50);
    expect(result.value.coverage).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(result.value.coverage.reasons).toContain('proof-edge-cap');
  });
});
