/**
 * graph:cycle (SCC bands) + graph:unexpected-coupling (package cycles) tests,
 * including the cross-rule non-overlap invariant.
 *
 * cycle ladder: sccSize 1 → nothing; 2 → cycleSize2Severity (off|low);
 * >= 3 → medium; crossesPackages → high (wins regardless of size).
 * unexpected-coupling: a package A→B→A cycle → one high signal, zero
 * project-specific config, no statistical-outlier signal. The two rules
 * cross-link a single cross-package tangle via distinct ruleIds + locations
 * (distinct fingerprints).
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { cycleRule } from '../../rules/cycle.js';
import { unexpectedCouplingRule } from '../../rules/unexpected-coupling.js';

import { makeCatalog, occ } from './_helpers.js';

import type { FeatureTable, GraphConfig, PackageEdgeFeature, SccFeatures } from '../../types.js';
import type { Signal } from '@opensip-cli/core';

const EMPTY: GraphConfig = {};

/** A baseline-fingerprint stand-in over (ruleId, file, line). */
function fingerprint(s: Signal): string {
  return `${s.ruleId}|${s.code?.file ?? ''}|${String(s.code?.line ?? '')}`;
}

function featureTable(over: Partial<FeatureTable>): FeatureTable {
  return {
    function: new Map(),
    package: new Map(),
    scc: [],
    edge: [],
    ...over,
  };
}

/** A single SCC fixture over `members`. */
function sccFixture(members: readonly string[], crossesPackages: boolean): SccFeatures {
  return {
    id: `scc:${members[0] ?? ''}`,
    members,
    sccSize: members.length,
    crossesPackages,
  };
}

describe('graph:cycle bands', () => {
  // One occurrence per member, each at a distinct source location so its occId
  // (`${filePath}:${line}:${column}`) is unique. SCC members are occIds.
  const catalog = makeCatalog([
    occ({
      bodyHash: 'm1',
      simpleName: 'a',
      qualifiedName: 'a',
      filePath: 'src/a.ts',
      line: 1,
    }),
    occ({
      bodyHash: 'm2',
      simpleName: 'b',
      qualifiedName: 'b',
      filePath: 'src/b.ts',
      line: 1,
    }),
    occ({
      bodyHash: 'm3',
      simpleName: 'c',
      qualifiedName: 'c',
      filePath: 'src/c.ts',
      line: 1,
    }),
  ]);
  const indexes = buildIndexes(catalog);
  const m1 = 'src/a.ts:1:0';
  const m2 = 'src/b.ts:1:0';
  const m3 = 'src/c.ts:1:0';

  function run(scc: SccFeatures, config: GraphConfig = EMPTY) {
    return cycleRule.evaluate(catalog, indexes, config, undefined, featureTable({ scc: [scc] }));
  }

  it('emits nothing for sccSize === 1', () => {
    expect(run(sccFixture([m1], false))).toEqual([]);
  });

  it('emits nothing for sccSize === 2 with default (off) posture', () => {
    expect(run(sccFixture([m1, m2], false))).toEqual([]);
  });

  it('emits low for sccSize === 2 when cycleSize2Severity is low', () => {
    const signals = run(sccFixture([m1, m2], false), {
      cycleSize2Severity: 'low',
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('low');
  });

  it('emits medium for sccSize >= 3 (intra-package)', () => {
    const signals = run(sccFixture([m1, m2, m3], false));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('medium');
    expect(signals[0]?.metadata.sccSize).toBe(3);
  });

  it('emits high when crossesPackages (regardless of size)', () => {
    expect(run(sccFixture([m1, m2], true))[0]?.severity).toBe('high');
    expect(run(sccFixture([m1, m2, m3], true))[0]?.severity).toBe('high');
  });

  it('emits one signal PER SCC, anchored on the lowest-qualifiedName member', () => {
    const signals = run(sccFixture([m3, m1, m2], false));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.metadata.qualifiedName).toBe('a'); // m1 → 'a' is lowest
  });

  it('returns [] when the feature table is absent', () => {
    expect(cycleRule.evaluate(catalog, indexes, EMPTY)).toEqual([]);
  });
});

describe('graph:cycle test-file exclusion', () => {
  const EMPTY: GraphConfig = {};
  // t1/t2/t3 live in test files; p1 is production.
  const catalog = makeCatalog([
    occ({
      bodyHash: 't1',
      simpleName: 't1',
      qualifiedName: 't1',
      filePath: 'src/a.test.ts',
      inTestFile: true,
    }),
    occ({
      bodyHash: 't2',
      simpleName: 't2',
      qualifiedName: 't2',
      filePath: 'src/b.test.ts',
      inTestFile: true,
    }),
    occ({
      bodyHash: 't3',
      simpleName: 't3',
      qualifiedName: 't3',
      filePath: 'src/c.test.ts',
      inTestFile: true,
    }),
    occ({
      bodyHash: 'p1',
      simpleName: 'p1',
      qualifiedName: 'p1',
      filePath: 'src/p.ts',
      inTestFile: false,
    }),
  ]);
  const indexes = buildIndexes(catalog);
  // SCC members are occIds (`${filePath}:${line}:${column}`).
  const t1 = 'src/a.test.ts:1:0';
  const t2 = 'src/b.test.ts:1:0';
  const t3 = 'src/c.test.ts:1:0';
  const p1 = 'src/p.ts:1:0';
  const run = (scc: SccFeatures) =>
    cycleRule.evaluate(catalog, indexes, EMPTY, undefined, featureTable({ scc: [scc] }));

  it('emits nothing for a cycle whose members are ALL in test files', () => {
    expect(run(sccFixture([t1, t2, t3], false))).toEqual([]);
  });

  it('still emits for a cycle that includes a production member', () => {
    const signals = run(sccFixture([t1, t2, p1], false));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.metadata.sccSize).toBe(3);
  });
});

describe('graph:unexpected-coupling package cycles', () => {
  // Two packages A and B with occurrences (so the rule can anchor a location).
  const catalog = makeCatalog([
    occ({
      bodyHash: 'a-init',
      simpleName: '<module-init:a>',
      kind: 'module-init',
      package: 'pkg-a',
      filePath: 'packages/a/src/index.ts',
    }),
    occ({
      bodyHash: 'b-init',
      simpleName: '<module-init:b>',
      kind: 'module-init',
      package: 'pkg-b',
      filePath: 'packages/b/src/index.ts',
    }),
  ]);
  const indexes = buildIndexes(catalog);

  const cycleEdges: PackageEdgeFeature[] = [
    { callerPackage: 'pkg-a', calleePackage: 'pkg-b', count: 3 },
    { callerPackage: 'pkg-b', calleePackage: 'pkg-a', count: 2 },
  ];

  it('emits one high signal for an A→B→A package cycle with zero config', () => {
    const signals = unexpectedCouplingRule.evaluate(
      catalog,
      indexes,
      {},
      undefined,
      featureTable({ edge: cycleEdges }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('high');
    expect(signals[0]?.metadata.packages).toEqual(['pkg-a', 'pkg-b']);
    // Phase 2 Task 2.3: package-coupling rules carry highImpact so
    // `--filter high-impact` selects them alongside the other high-impact rules.
    expect(signals[0]?.metadata.highImpact).toBe(true);
  });

  it('emits nothing when there is no reverse edge (no cycle)', () => {
    const oneWay: PackageEdgeFeature[] = [
      { callerPackage: 'pkg-a', calleePackage: 'pkg-b', count: 3 },
    ];
    expect(
      unexpectedCouplingRule.evaluate(
        catalog,
        indexes,
        {},
        undefined,
        featureTable({ edge: oneWay }),
      ),
    ).toEqual([]);
  });

  it('ignores package self-loops (A→A is not a pair cycle)', () => {
    const selfLoop: PackageEdgeFeature[] = [
      { callerPackage: 'pkg-a', calleePackage: 'pkg-a', count: 5 },
    ];
    expect(
      unexpectedCouplingRule.evaluate(
        catalog,
        indexes,
        {},
        undefined,
        featureTable({ edge: selfLoop }),
      ),
    ).toEqual([]);
  });

  it('emits no statistical-outlier signal — only the package-cycle slug', () => {
    const signals = unexpectedCouplingRule.evaluate(
      catalog,
      indexes,
      {},
      undefined,
      featureTable({ edge: cycleEdges }),
    );
    for (const s of signals) {
      expect(s.ruleId).toBe('graph:unexpected-coupling');
      expect(JSON.stringify(s.metadata)).not.toContain('outlier');
    }
  });

  it('returns [] when the feature table is absent', () => {
    expect(unexpectedCouplingRule.evaluate(catalog, indexes, {})).toEqual([]);
  });
});

describe('graph:cycle ↔ graph:unexpected-coupling non-overlap', () => {
  it('a single cross-package tangle yields one cycle signal + at most one coupling signal, distinct fingerprints', () => {
    // Two functions in packages A and B that form one cross-package SCC, with
    // the matching package edges A↔B.
    const fnA = occ({
      bodyHash: 'fa',
      simpleName: 'fa',
      qualifiedName: 'a.fa',
      package: 'pkg-a',
      filePath: 'packages/a/src/x.ts',
    });
    const fnB = occ({
      bodyHash: 'fb',
      simpleName: 'fb',
      qualifiedName: 'b.fb',
      package: 'pkg-b',
      filePath: 'packages/b/src/y.ts',
    });
    const catalog = makeCatalog([fnA, fnB]);
    const indexes = buildIndexes(catalog);

    // SCC members are occIds (`${filePath}:${line}:${column}`).
    const scc = sccFixture(['packages/a/src/x.ts:1:0', 'packages/b/src/y.ts:1:0'], true);
    const edges: PackageEdgeFeature[] = [
      { callerPackage: 'pkg-a', calleePackage: 'pkg-b', count: 1 },
      { callerPackage: 'pkg-b', calleePackage: 'pkg-a', count: 1 },
    ];
    const features = featureTable({ scc: [scc], edge: edges });

    const cycleSignals = cycleRule.evaluate(catalog, indexes, EMPTY, undefined, features);
    const couplingSignals = unexpectedCouplingRule.evaluate(
      catalog,
      indexes,
      {},
      undefined,
      features,
    );

    expect(cycleSignals).toHaveLength(1);
    expect(couplingSignals).toHaveLength(1);

    const c = cycleSignals[0];
    const u = couplingSignals[0];

    // Distinct ruleIds → distinct fingerprints even at the same altitude.
    expect(c.ruleId).toBe('graph:cycle');
    expect(u.ruleId).toBe('graph:unexpected-coupling');
    expect(c.ruleId).not.toBe(u.ruleId);

    // Cross-linked via metadata.
    expect(c.metadata.relatedPackageCycle).toEqual(['pkg-a', 'pkg-b']);
    expect(u.metadata.relatedSccCount).toBe(1);

    // A fingerprint over (ruleId, file, line) differs.
    expect(fingerprint(c)).not.toBe(fingerprint(u));
  });

  it('both rules return [] for an empty catalog', () => {
    const empty = featureTable({});
    expect(
      cycleRule.evaluate(makeCatalog([]), buildIndexes(makeCatalog([])), EMPTY, undefined, empty),
    ).toEqual([]);
    expect(
      unexpectedCouplingRule.evaluate(
        makeCatalog([]),
        buildIndexes(makeCatalog([])),
        {},
        undefined,
        empty,
      ),
    ).toEqual([]);
  });
});
