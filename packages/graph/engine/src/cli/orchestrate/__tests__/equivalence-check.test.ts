/**
 * Unit tests for the real-repo equivalence guardrail's pure classification +
 * judging logic (`equivalence-check.ts`). These do NOT build real catalogs — the
 * end-to-end real build is the dogfood CI step `graph-equivalence-check`; here we
 * verify the owner-file classification (production vs test/fixture vs structural)
 * and the ratchet verdict (hard-fail on function-set breach; budget-gate on
 * production resolved edges + SCCs; PASS-with-tighten-hint on a decrease).
 */

import { describe, expect, it } from 'vitest';

import {
  buildEquivalenceReport,
  countResolvedCrossPackageEdges,
  isTestOrFixturePath,
  judgeEquivalence,
  type EquivalenceReport,
} from '../equivalence-check.js';

import type { Catalog, FunctionOccurrence } from '../../../types.js';
import type { Shard } from '../shard-model.js';

// ── isTestOrFixturePath ────────────────────────────────────────────

describe('isTestOrFixturePath', () => {
  it('flags __tests__/ and __fixtures__/ trees and *.test/*.spec files', () => {
    expect(isTestOrFixturePath('packages/x/src/__tests__/a.ts')).toBe(true);
    expect(isTestOrFixturePath('__tests__/a.ts')).toBe(true);
    expect(isTestOrFixturePath('packages/x/__fixtures__/f.ts')).toBe(true);
    expect(isTestOrFixturePath('packages/x/src/a.test.ts')).toBe(true);
    expect(isTestOrFixturePath('packages/x/src/a.spec.tsx')).toBe(true);
  });
  it('does NOT flag production source', () => {
    expect(isTestOrFixturePath('packages/x/src/a.ts')).toBe(false);
    expect(isTestOrFixturePath('packages/x/src/framework/file-accessor.ts')).toBe(false);
    // "test" as a substring of a non-test filename must not match.
    expect(isTestOrFixturePath('packages/x/src/test-utils.ts')).toBe(false);
  });
});

// ── catalog fixtures ───────────────────────────────────────────────

/** Build a one-occurrence catalog where `owner` (in `file`) calls `to` at line. */
function occ(
  file: string,
  bodyHash: string,
  to: string[],
  line = 10,
  column = 4,
): FunctionOccurrence {
  return {
    bodyHash,
    simpleName: 'owner',
    qualifiedName: `${file}.owner`,
    filePath: file,
    line,
    column,
    endLine: line + 1,
    kind: 'function',
    visibility: 'exported',
    params: [],
    calls: [{ to, line, column, resolution: 'semantic', confidence: 'high', text: 'call()' }],
  } as unknown as FunctionOccurrence;
}

function catalogOf(...occs: FunctionOccurrence[]): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  if (occs.length > 0) functions.owner = [...occs];
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-01-01T00:00:00.000Z',
    cacheKey: 'test',
    functions,
  } as unknown as Catalog;
}

const NO_SHARDS: readonly Shard[] = [
  { id: 'a', rootDir: '/a', files: [] },
  { id: 'b', rootDir: '/b', files: [] },
];

async function reportFor(exact: Catalog, sharded: Catalog): Promise<EquivalenceReport> {
  return buildEquivalenceReport({
    cwd: '/repo',
    shards: NO_SHARDS,
    cliScript: '/cli.js',
    buildExact: () => Promise.resolve(exact),
    buildSharded: () => Promise.resolve(sharded),
  });
}

// ── classification ─────────────────────────────────────────────────

describe('buildEquivalenceReport classification', () => {
  it('classifies a production resolved divergence (sharded resolves, exact does not)', async () => {
    // Same owner occurrence (same bodyHash) in both, but exact has an empty edge
    // and sharded resolves a target → a RESOLVED divergence owned by prod source.
    const exact = catalogOf(occ('packages/x/src/a.ts', 'H', []));
    const sharded = catalogOf(occ('packages/x/src/a.ts', 'H', ['TARGET']));
    const r = await reportFor(exact, sharded);

    expect(r.functionsOnlyInExact).toEqual([]);
    expect(r.functionsOnlyInSharded).toEqual([]);
    expect(r.productionResolvedDifferences).toHaveLength(1);
    expect(r.productionResolvedDifferences[0]?.ownerFilePath).toBe('packages/x/src/a.ts');
    // exact empty + sharded resolved ⇒ a PHANTOM-direction divergence.
    expect(r.productionPhantom).toHaveLength(1);
    expect(r.productionDecline).toEqual([]);
    expect(r.productionConflict).toEqual([]);
    expect(r.testResolvedDifferences).toEqual([]);
    expect(r.structuralDifferences).toEqual([]);
  });

  it('classifies a test-owned resolved divergence as benign (not production)', async () => {
    const exact = catalogOf(occ('packages/x/src/__tests__/a.ts', 'H', []));
    const sharded = catalogOf(occ('packages/x/src/__tests__/a.ts', 'H', ['TARGET']));
    const r = await reportFor(exact, sharded);
    expect(r.productionResolvedDifferences).toEqual([]);
    expect(r.testResolvedDifferences).toHaveLength(1);
  });

  it('classifies unresolved-vs-absent as STRUCTURAL, never production', async () => {
    // Exact records an unresolved (to:[]) edge at the site; sharded has NO edge
    // there at all (owner occurrence absent) → both effectively empty → structural.
    const exact = catalogOf(occ('packages/x/src/a.ts', 'H', []));
    const sharded = catalogOf(); // owner absent → no edge at that key
    const r = await reportFor(exact, sharded);
    expect(r.productionResolvedDifferences).toEqual([]);
    expect(r.testResolvedDifferences).toEqual([]);
    expect(r.structuralDifferences).toHaveLength(1);
  });
});

// ── judging / ratchet ──────────────────────────────────────────────

function reportWith(over: Partial<EquivalenceReport>): EquivalenceReport {
  return {
    functionsOnlyInExact: [],
    functionsOnlyInSharded: [],
    sccDifferences: [],
    allEdgeDifferences: [],
    productionResolvedDifferences: [],
    productionPhantom: [],
    productionDecline: [],
    productionConflict: [],
    testResolvedDifferences: [],
    structuralDifferences: [],
    exactFunctionCount: 100,
    shardedFunctionCount: 100,
    ...over,
  };
}

type Diff = EquivalenceReport['productionResolvedDifferences'][number];

/** A divergence in a given direction: phantom (sharded-only), decline (exact-only),
 *  conflict (both differ). `toA`=exact, `toB`=sharded. */
const diffOf = (owner: string, toA: string, toB: string): Diff => ({
  key: `${owner}@1:1`,
  ownerFilePath: owner,
  line: 1,
  column: 1,
  toA,
  toB,
  cross: true,
});
const phantom = (owner: string): Diff => diffOf(owner, '', 'X'); // sharded-only
const decline = (owner: string): Diff => diffOf(owner, 'X', ''); // exact-only
const conflict = (owner: string): Diff => diffOf(owner, 'X', 'Y'); // both differ

/** Build a report whose three directional partitions are populated, with the
 *  total kept consistent (the judge reads the partitions for gating). */
function reportWithDirections(d: {
  phantom?: Diff[];
  decline?: Diff[];
  conflict?: Diff[];
  scc?: string[];
  functionsOnlyInExact?: string[];
}): EquivalenceReport {
  const p = d.phantom ?? [];
  const dec = d.decline ?? [];
  const c = d.conflict ?? [];
  return reportWith({
    productionResolvedDifferences: [...p, ...dec, ...c],
    productionPhantom: p,
    productionDecline: dec,
    productionConflict: c,
    sccDifferences: d.scc ?? [],
    ...(d.functionsOnlyInExact ? { functionsOnlyInExact: d.functionsOnlyInExact } : {}),
  });
}

const FLOOR = {
  phantomDivergences: 0,
  declineDivergences: 0,
  conflictDivergences: 0,
  sccDivergences: 0,
};

describe('judgeEquivalence directional ratchet', () => {
  it('PASSES when every direction + SCC match their floors', () => {
    const v = judgeEquivalence(
      reportWithDirections({
        phantom: [phantom('p/a.ts')],
        conflict: [conflict('p/b.ts')],
        scc: ['s'],
      }),
      { ...FLOOR, phantomDivergences: 1, conflictDivergences: 1, sccDivergences: 1 },
    );
    expect(v.failed).toBe(false);
    expect(v.phantomCount).toBe(1);
    expect(v.conflictCount).toBe(1);
  });

  it('FAILS when a direction EXCEEDS its floor and prints the offenders for THAT direction', () => {
    const v = judgeEquivalence(
      reportWithDirections({ phantom: [phantom('p/a.ts'), phantom('p/c.ts')] }),
      { ...FLOOR, phantomDivergences: 1 },
    );
    expect(v.failed).toBe(true);
    expect(v.lines.join('\n')).toContain('EXCEEDS budget');
    expect(v.lines.join('\n')).toContain('p/a.ts:1:1');
  });

  it('counts each direction independently (phantom / decline / conflict)', () => {
    const v = judgeEquivalence(
      reportWithDirections({
        phantom: [phantom('p/a.ts')],
        decline: [decline('p/b.ts'), decline('p/c.ts')],
        conflict: [conflict('p/d.ts')],
      }),
      { ...FLOOR, phantomDivergences: 1, declineDivergences: 2, conflictDivergences: 1 },
    );
    expect(v.failed).toBe(false);
    expect(v.phantomCount).toBe(1);
    expect(v.declineCount).toBe(2);
    expect(v.conflictCount).toBe(1);
    expect(v.productionCount).toBe(4);
  });

  it('a NEW phantom is NOT masked by a fixed conflict (per-direction gating)', () => {
    // Total stays 2, but a conflict was "fixed" into a new phantom: phantom
    // exceeds its floor (0) even though the total equals the old total.
    const v = judgeEquivalence(
      reportWithDirections({ phantom: [phantom('p/a.ts'), phantom('p/b.ts')] }),
      {
        ...FLOOR,
        phantomDivergences: 0,
        conflictDivergences: 2,
      },
    );
    expect(v.failed).toBe(true);
  });

  it('FAILS when SCC divergence EXCEEDS its floor', () => {
    const v = judgeEquivalence(reportWithDirections({ scc: ['s1', 's2'] }), {
      ...FLOOR,
      sccDivergences: 1,
    });
    expect(v.failed).toBe(true);
  });

  it('PASSES with a tighten hint when a direction is BELOW its floor', () => {
    const v = judgeEquivalence(reportWithDirections({ phantom: [phantom('p/a.ts')] }), {
      ...FLOOR,
      phantomDivergences: 5,
    });
    expect(v.failed).toBe(false);
    expect(v.lines.join('\n')).toContain('tighten the ratchet');
  });

  it('HARD-FAILS on a function-set breach regardless of budget', () => {
    const v = judgeEquivalence(reportWithDirections({ functionsOnlyInExact: ['ghost'] }), {
      phantomDivergences: 1000,
      declineDivergences: 1000,
      conflictDivergences: 1000,
      sccDivergences: 1000,
    });
    expect(v.failed).toBe(true);
    expect(v.functionSetBreached).toBe(true);
    expect(v.lines.join('\n')).toContain('function-set divergence');
  });
});

// ── completeness floor (countResolvedCrossPackageEdges) ─────────────

/** A catalog whose single occurrence carries the given edges. */
function catalogWithEdges(edges: { to: string[]; crossShard?: boolean }[]): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-01-01T00:00:00.000Z',
    cacheKey: 'test',
    functions: {
      owner: [
        {
          bodyHash: 'H',
          simpleName: 'owner',
          qualifiedName: 'f.owner',
          filePath: 'packages/x/src/a.ts',
          line: 1,
          column: 0,
          calls: edges.map((e, i) => ({
            to: e.to,
            line: 10 + i,
            column: 0,
            resolution: 'semantic',
            confidence: 'high',
            text: 'call()',
            ...(e.crossShard === undefined ? {} : { crossShard: e.crossShard }),
          })),
        },
      ],
    },
  } as unknown as Catalog;
}

describe('countResolvedCrossPackageEdges (completeness metric)', () => {
  it('counts ONLY resolved crossShard edges (excludes intra + declined)', () => {
    const cat = catalogWithEdges([
      { to: ['T1'], crossShard: true }, // resolved cross-package ✓
      { to: ['T2'], crossShard: true }, // resolved cross-package ✓
      { to: ['LOCAL'] }, // intra (no crossShard) ✗
      { to: [], crossShard: true }, // declined crossShard placeholder ✗
    ]);
    expect(countResolvedCrossPackageEdges(cat)).toBe(2);
  });

  it('a both-engine drop falls below a floor the differential gate cannot see', () => {
    // Both "engines" would produce this same degraded catalog ⇒ ZERO differential
    // divergence, yet the resolved cross-package count collapsed. The floor is the
    // only guard for this case.
    const FLOOR_EXAMPLE = 2;
    const degraded = catalogWithEdges([{ to: [], crossShard: true }]); // both declined
    expect(countResolvedCrossPackageEdges(degraded)).toBeLessThan(FLOOR_EXAMPLE);
  });
});
