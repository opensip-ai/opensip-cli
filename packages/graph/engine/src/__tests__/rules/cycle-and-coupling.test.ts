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

const EMPTY: GraphConfig = {};

function featureTable(over: Partial<FeatureTable>): FeatureTable {
  return { function: new Map(), package: new Map(), scc: [], edge: [], ...over };
}

/** A single SCC fixture over `members`. */
function sccFixture(members: readonly string[], crossesPackages: boolean): SccFeatures {
  return { id: `scc:${members[0] ?? ''}`, members, sccSize: members.length, crossesPackages };
}

describe('graph:cycle bands', () => {
  // One occurrence per member hash so the rule can anchor a location.
  const catalog = makeCatalog([
    occ({ bodyHash: 'm1', simpleName: 'a', qualifiedName: 'a' }),
    occ({ bodyHash: 'm2', simpleName: 'b', qualifiedName: 'b' }),
    occ({ bodyHash: 'm3', simpleName: 'c', qualifiedName: 'c' }),
  ]);
  const indexes = buildIndexes(catalog);

  function run(scc: SccFeatures, config: GraphConfig = EMPTY) {
    return cycleRule.evaluate(catalog, indexes, config, undefined, featureTable({ scc: [scc] }));
  }

  it('emits nothing for sccSize === 1', () => {
    expect(run(sccFixture(['m1'], false))).toEqual([]);
  });

  it('emits nothing for sccSize === 2 with default (off) posture', () => {
    expect(run(sccFixture(['m1', 'm2'], false))).toEqual([]);
  });

  it('emits low for sccSize === 2 when cycleSize2Severity is low', () => {
    const signals = run(sccFixture(['m1', 'm2'], false), { cycleSize2Severity: 'low' });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('low');
  });

  it('emits medium for sccSize >= 3 (intra-package)', () => {
    const signals = run(sccFixture(['m1', 'm2', 'm3'], false));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('medium');
    expect(signals[0]?.metadata.sccSize).toBe(3);
  });

  it('emits high when crossesPackages (regardless of size)', () => {
    expect(run(sccFixture(['m1', 'm2'], true))[0]?.severity).toBe('high');
    expect(run(sccFixture(['m1', 'm2', 'm3'], true))[0]?.severity).toBe('high');
  });

  it('emits one signal PER SCC, anchored on the lowest-qualifiedName member', () => {
    const signals = run(sccFixture(['m3', 'm1', 'm2'], false));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.metadata.qualifiedName).toBe('a'); // m1 → 'a' is lowest
  });

  it('returns [] when the feature table is absent', () => {
    expect(cycleRule.evaluate(catalog, indexes, EMPTY)).toEqual([]);
  });
});

describe('graph:unexpected-coupling package cycles', () => {
  // Two packages A and B with occurrences (so the rule can anchor a location).
  const catalog = makeCatalog([
    occ({ bodyHash: 'a-init', simpleName: '<module-init:a>', kind: 'module-init', package: 'pkg-a', filePath: 'packages/a/src/index.ts' }),
    occ({ bodyHash: 'b-init', simpleName: '<module-init:b>', kind: 'module-init', package: 'pkg-b', filePath: 'packages/b/src/index.ts' }),
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
  });

  it('emits nothing when there is no reverse edge (no cycle)', () => {
    const oneWay: PackageEdgeFeature[] = [{ callerPackage: 'pkg-a', calleePackage: 'pkg-b', count: 3 }];
    expect(
      unexpectedCouplingRule.evaluate(catalog, indexes, {}, undefined, featureTable({ edge: oneWay })),
    ).toEqual([]);
  });

  it('ignores package self-loops (A→A is not a pair cycle)', () => {
    const selfLoop: PackageEdgeFeature[] = [{ callerPackage: 'pkg-a', calleePackage: 'pkg-a', count: 5 }];
    expect(
      unexpectedCouplingRule.evaluate(catalog, indexes, {}, undefined, featureTable({ edge: selfLoop })),
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
    const fnA = occ({ bodyHash: 'fa', simpleName: 'fa', qualifiedName: 'a.fa', package: 'pkg-a', filePath: 'packages/a/src/x.ts' });
    const fnB = occ({ bodyHash: 'fb', simpleName: 'fb', qualifiedName: 'b.fb', package: 'pkg-b', filePath: 'packages/b/src/y.ts' });
    const catalog = makeCatalog([fnA, fnB]);
    const indexes = buildIndexes(catalog);

    const scc = sccFixture(['fa', 'fb'], true);
    const edges: PackageEdgeFeature[] = [
      { callerPackage: 'pkg-a', calleePackage: 'pkg-b', count: 1 },
      { callerPackage: 'pkg-b', calleePackage: 'pkg-a', count: 1 },
    ];
    const features = featureTable({ scc: [scc], edge: edges });

    const cycleSignals = cycleRule.evaluate(catalog, indexes, EMPTY, undefined, features);
    const couplingSignals = unexpectedCouplingRule.evaluate(catalog, indexes, {}, undefined, features);

    expect(cycleSignals).toHaveLength(1);
    expect(couplingSignals).toHaveLength(1);

    const c = cycleSignals[0]!;
    const u = couplingSignals[0]!;

    // Distinct ruleIds → distinct fingerprints even at the same altitude.
    expect(c.ruleId).toBe('graph:cycle');
    expect(u.ruleId).toBe('graph:unexpected-coupling');
    expect(c.ruleId).not.toBe(u.ruleId);

    // Cross-linked via metadata.
    expect(c.metadata.relatedPackageCycle).toEqual(['pkg-a', 'pkg-b']);
    expect(u.metadata.relatedSccCount).toBe(1);

    // A fingerprint over (ruleId, file, line) differs.
    const fp = (s: typeof c) => `${s.ruleId}|${s.code?.file ?? ''}|${String(s.code?.line ?? '')}`;
    expect(fp(c)).not.toBe(fp(u));
  });

  it('both rules return [] for an empty catalog', () => {
    const empty = featureTable({});
    expect(cycleRule.evaluate(makeCatalog([]), buildIndexes(makeCatalog([])), EMPTY, undefined, empty)).toEqual([]);
    expect(unexpectedCouplingRule.evaluate(makeCatalog([]), buildIndexes(makeCatalog([])), {}, undefined, empty)).toEqual([]);
  });
});
