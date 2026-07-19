/**
 * Unit tests for the PURE equivalence-diagnostic builder. No fs / env / clock —
 * the host command owns those effects; here we assert the analysis maps a
 * decline/phantom/conflict divergence to a symmetric per-engine description.
 */

import { describe, expect, it } from 'vitest';

import { buildEquivalenceDiagnostic } from '../equivalence-diagnostic.js';

import type { Catalog, CallEdge, FunctionOccurrence } from '../../types.js';
import type { EdgeDifference } from '../orchestrate/cross-shard-resolve.js';

const DEFAULT_OCCURRENCE_POSITION = { line: 1, column: 0 } as const;

function occ(
  simpleName: string,
  filePath: string,
  bodyHash: string,
  calls: readonly CallEdge[] = [],
  position: { readonly line: number; readonly column: number } = DEFAULT_OCCURRENCE_POSITION,
): FunctionOccurrence {
  return {
    bodyHash,
    simpleName,
    qualifiedName: `${filePath}.${simpleName}`,
    filePath,
    line: position.line,
    column: position.column,
    endLine: position.line,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls,
  };
}

function fragment(...occs: FunctionOccurrence[]): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const o of occs) {
    const bucket = functions[o.simpleName];
    if (bucket) bucket.push(o);
    else functions[o.simpleName] = [o];
  }
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'key',
    resolutionMode: 'exact',
    functions,
  };
}

const edge = (over: Partial<CallEdge> & Pick<CallEdge, 'to'>): CallEdge => ({
  line: 5,
  column: 9,
  resolution: 'semantic',
  confidence: 'high',
  text: 'target()',
  ...over,
});

function diff(over: Partial<EdgeDifference>): EdgeDifference {
  return {
    key: 'packages/a/src/caller.ts:1:0@5:9',
    ownerBodyHash: 'OWNER',
    ownerFilePath: 'packages/a/src/caller.ts',
    ownerLine: 1,
    ownerColumn: 0,
    line: 5,
    column: 9,
    toA: '',
    toB: '',
    cross: true,
    ...over,
  };
}

const SHARDS = [{ id: 'pkg:a', rootDir: '/repo/packages/a', files: ['f1.ts', 'f2.ts'] }];

describe('buildEquivalenceDiagnostic', () => {
  it('describes a decline (exact resolved, sharded declined) symmetrically', () => {
    const exactEdge = edge({
      to: ['TGT'],
      resolution: 'semantic',
      crossShard: true,
    });
    const shardedEdge = edge({
      to: [],
      resolution: 'unknown',
      confidence: 'low',
    });
    const exact = fragment(
      occ('caller', 'packages/a/src/caller.ts', 'OWNER', [exactEdge]),
      occ('target', 'packages/b/src/target.ts', 'TGT'),
    );
    const sharded = fragment(
      occ('caller', 'packages/a/src/caller.ts', 'OWNER', [shardedEdge]),
      occ('target', 'packages/b/src/target.ts', 'TGT'),
    );

    const out = buildEquivalenceDiagnostic({
      report: {
        productionDecline: [diff({ toA: 'TGT', toB: '' })],
        productionPhantom: [],
        productionConflict: [],
      },
      exact,
      sharded,
      shards: SHARDS,
    });

    expect(out.counts).toEqual({
      productionDecline: 1,
      productionPhantom: 0,
      productionConflict: 0,
    });
    expect(out.shards).toEqual([{ id: 'pkg:a', rootDir: '/repo/packages/a', fileCount: 2 }]);

    const d = out.decline[0];
    expect(d.owner.hash).toBe('OWNER');
    expect(d.owner.exact?.simpleName).toBe('caller');
    expect(d.owner.sharded?.simpleName).toBe('caller');
    expect(d.exactEdge?.to).toEqual(['TGT']);
    expect(d.exactEdge?.resolution).toBe('semantic');
    expect(d.exactEdge?.crossShard).toBe(true);
    expect(d.shardedEdge?.to).toEqual([]);
    expect(d.shardedEdge?.resolution).toBe('unknown');
    expect(d.exactTo).toEqual([
      {
        hash: 'TGT',
        occurrences: [expect.objectContaining({ simpleName: 'target' })],
      },
    ]);
    expect(d.shardedTo).toEqual([]);
    // Histogram keys on `<resolution>:<crossShard>` of the exact edge.
    expect(out.declineByExactResolution).toEqual({ 'semantic:true': 1 });
  });

  it('describes a phantom (sharded resolved, exact declined) and histograms it', () => {
    const exact = fragment(occ('caller', 'packages/a/src/caller.ts', 'OWNER', [edge({ to: [] })]));
    const sharded = fragment(
      occ('caller', 'packages/a/src/caller.ts', 'OWNER', [
        edge({ to: ['TGT'], resolution: 'semantic', crossShard: true }),
      ]),
      occ('target', 'packages/b/src/target.ts', 'TGT'),
    );

    const out = buildEquivalenceDiagnostic({
      report: {
        productionDecline: [],
        productionPhantom: [diff({ toA: '', toB: 'TGT' })],
        productionConflict: [],
      },
      exact,
      sharded,
      shards: SHARDS,
    });

    expect(out.counts).toEqual({
      productionDecline: 0,
      productionPhantom: 1,
      productionConflict: 0,
    });
    const p = out.phantom[0];
    expect(p.shardedEdge?.to).toEqual(['TGT']);
    expect(p.shardedTo).toEqual([
      {
        hash: 'TGT',
        occurrences: [expect.objectContaining({ simpleName: 'target' })],
      },
    ]);
    expect(p.exactTo).toEqual([]);
    expect(out.phantomByShardedResolution).toEqual({ 'semantic:true': 1 });
  });

  it('emits null edge/owner summaries when the occurrence is absent from a catalog', () => {
    // sharded never saw the owner at all → its owner + same-site edge are null.
    const exact = fragment(
      occ('caller', 'packages/a/src/caller.ts', 'OWNER', [edge({ to: ['TGT'] })]),
      occ('target', 'packages/b/src/target.ts', 'TGT'),
    );
    const sharded = fragment(occ('unrelated', 'packages/c/src/x.ts', 'OTHER'));

    const out = buildEquivalenceDiagnostic({
      report: {
        productionDecline: [diff({ toA: 'TGT', toB: '' })],
        productionPhantom: [],
        productionConflict: [],
      },
      exact,
      sharded,
      shards: SHARDS,
    });

    const d = out.decline[0];
    expect(d.owner.exact?.simpleName).toBe('caller');
    expect(d.owner.sharded).toBeNull();
    expect(d.shardedEdge).toBeNull();
    expect(d.shardedSameSite).toBeNull();
    expect(d.exactSameSite?.to).toEqual(['TGT']);
  });

  it('describes a conflict and histograms the exact/sharded resolution pair', () => {
    const exact = fragment(
      occ('caller', 'packages/a/src/caller.ts', 'OWNER', [
        edge({ to: ['WRONG'], resolution: 'unknown', confidence: 'medium' }),
      ]),
      occ('wrong', 'packages/a/src/wrong.ts', 'WRONG'),
      occ('right', 'packages/b/src/right.ts', 'RIGHT'),
    );
    const sharded = fragment(
      occ('caller', 'packages/a/src/caller.ts', 'OWNER', [
        edge({
          to: ['RIGHT'],
          resolution: 'semantic',
          confidence: 'high',
          crossShard: true,
        }),
      ]),
      occ('wrong', 'packages/a/src/wrong.ts', 'WRONG'),
      occ('right', 'packages/b/src/right.ts', 'RIGHT'),
    );

    const out = buildEquivalenceDiagnostic({
      report: {
        productionDecline: [],
        productionPhantom: [],
        productionConflict: [diff({ toA: 'WRONG', toB: 'RIGHT' })],
      },
      exact,
      sharded,
      shards: SHARDS,
    });

    expect(out.counts).toEqual({
      productionDecline: 0,
      productionPhantom: 0,
      productionConflict: 1,
    });
    expect(out.conflict).toHaveLength(1);
    expect(out.conflict[0]?.exactEdge).toEqual(
      expect.objectContaining({
        to: ['WRONG'],
        resolution: 'unknown',
        confidence: 'medium',
      }),
    );
    expect(out.conflict[0]?.shardedEdge).toEqual(
      expect.objectContaining({
        to: ['RIGHT'],
        resolution: 'semantic',
        confidence: 'high',
        crossShard: true,
      }),
    );
    expect(out.conflictByResolutionPair).toEqual({
      'unknown:false->semantic:true': 1,
    });
  });

  it('selects a same-file body-twin owner by declaration line and column', () => {
    const callerFile = 'packages/a/src/caller.ts';
    const firstTwinExact = occ('caller', callerFile, 'OWNER', [edge({ to: ['FIRST'] })], {
      line: 3,
      column: 0,
    });
    const selectedTwinExact = occ('caller', callerFile, 'OWNER', [edge({ to: ['EXACT'] })], {
      line: 3,
      column: 24,
    });
    const firstTwinSharded = occ('caller', callerFile, 'OWNER', [edge({ to: ['FIRST'] })], {
      line: 3,
      column: 0,
    });
    const selectedTwinSharded = occ(
      'caller',
      callerFile,
      'OWNER',
      [edge({ to: ['SHARDED'], crossShard: true })],
      { line: 3, column: 24 },
    );

    const out = buildEquivalenceDiagnostic({
      report: {
        productionDecline: [],
        productionPhantom: [],
        productionConflict: [
          diff({
            key: `${callerFile}:3:24@5:9`,
            ownerLine: 3,
            ownerColumn: 24,
            toA: 'EXACT',
            toB: 'SHARDED',
          }),
        ],
      },
      exact: fragment(
        firstTwinExact,
        selectedTwinExact,
        occ('first', 'packages/a/src/first.ts', 'FIRST'),
        occ('exact', 'packages/a/src/exact.ts', 'EXACT'),
      ),
      sharded: fragment(
        firstTwinSharded,
        selectedTwinSharded,
        occ('first', 'packages/a/src/first.ts', 'FIRST'),
        occ('sharded', 'packages/b/src/sharded.ts', 'SHARDED'),
      ),
      shards: SHARDS,
    });

    const conflict = out.conflict[0];
    expect(conflict?.owner).toEqual(
      expect.objectContaining({
        hash: 'OWNER',
        filePath: callerFile,
        line: 3,
        column: 24,
      }),
    );
    expect(conflict?.owner.exact?.column).toBe(24);
    expect(conflict?.owner.sharded?.column).toBe(24);
    expect(conflict?.exactEdge?.to).toEqual(['EXACT']);
    expect(conflict?.shardedEdge?.to).toEqual(['SHARDED']);
  });
});
