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
function occ(file: string, bodyHash: string, to: string[], line = 10, column = 4): FunctionOccurrence {
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
    testResolvedDifferences: [],
    structuralDifferences: [],
    exactFunctionCount: 100,
    shardedFunctionCount: 100,
    ...over,
  };
}

const diff = (owner: string): EquivalenceReport['productionResolvedDifferences'][number] => ({
  key: `${owner}@1:1`,
  ownerFilePath: owner,
  line: 1,
  column: 1,
  toA: '',
  toB: 'X',
  cross: true,
});

describe('judgeEquivalence ratchet', () => {
  it('PASSES when production + SCC match the budget', () => {
    const v = judgeEquivalence(
      reportWith({ productionResolvedDifferences: [diff('p/a.ts'), diff('p/b.ts')], sccDifferences: ['s'] }),
      { productionResolvedEdgeDivergences: 2, sccDivergences: 1 },
    );
    expect(v.failed).toBe(false);
  });

  it('FAILS when production EXCEEDS budget (a regression spike) and prints offenders', () => {
    const v = judgeEquivalence(
      reportWith({ productionResolvedDifferences: [diff('p/a.ts'), diff('p/b.ts'), diff('p/c.ts')] }),
      { productionResolvedEdgeDivergences: 1, sccDivergences: 0 },
    );
    expect(v.failed).toBe(true);
    expect(v.lines.join('\n')).toContain('EXCEEDS budget');
    expect(v.lines.join('\n')).toContain('p/a.ts:1:1');
  });

  it('FAILS when SCC divergence EXCEEDS its budget', () => {
    const v = judgeEquivalence(
      reportWith({ sccDifferences: ['s1', 's2'] }),
      { productionResolvedEdgeDivergences: 0, sccDivergences: 1 },
    );
    expect(v.failed).toBe(true);
  });

  it('PASSES with a tighten hint when production is BELOW budget', () => {
    const v = judgeEquivalence(
      reportWith({ productionResolvedDifferences: [diff('p/a.ts')] }),
      { productionResolvedEdgeDivergences: 5, sccDivergences: 0 },
    );
    expect(v.failed).toBe(false);
    expect(v.lines.join('\n')).toContain('tighten the ratchet');
  });

  it('HARD-FAILS on a function-set breach regardless of budget', () => {
    const v = judgeEquivalence(
      reportWith({ functionsOnlyInExact: ['ghost'] }),
      { productionResolvedEdgeDivergences: 1000, sccDivergences: 1000 },
    );
    expect(v.failed).toBe(true);
    expect(v.functionSetBreached).toBe(true);
    expect(v.lines.join('\n')).toContain('function-set divergence');
  });
});
