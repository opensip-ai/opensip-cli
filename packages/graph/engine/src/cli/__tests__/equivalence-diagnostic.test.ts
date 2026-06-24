/**
 * Unit tests for the PURE equivalence-diagnostic builder. No fs / env / clock —
 * the host command owns those effects; here we assert the analysis maps a
 * decline/phantom divergence to a symmetric per-engine description.
 */

import { describe, expect, it } from 'vitest';

import { buildEquivalenceDiagnostic } from '../equivalence-diagnostic.js';

import type { Catalog, CallEdge, FunctionOccurrence } from '../../types.js';
import type { EdgeDifference } from '../orchestrate/cross-shard-resolve.js';

function occ(
  simpleName: string,
  filePath: string,
  bodyHash: string,
  calls: readonly CallEdge[] = [],
): FunctionOccurrence {
  return {
    bodyHash,
    simpleName,
    qualifiedName: `${filePath}.${simpleName}`,
    filePath,
    line: 1,
    column: 0,
    endLine: 1,
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
    key: 'OWNER@caller',
    ownerFilePath: 'packages/a/src/caller.ts',
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
    const exactEdge = edge({ to: ['TGT'], resolution: 'semantic', crossShard: true });
    const shardedEdge = edge({ to: [], resolution: 'unknown', confidence: 'low' });
    const exact = fragment(
      occ('caller', 'packages/a/src/caller.ts', 'OWNER', [exactEdge]),
      occ('target', 'packages/b/src/target.ts', 'TGT'),
    );
    const sharded = fragment(
      occ('caller', 'packages/a/src/caller.ts', 'OWNER', [shardedEdge]),
      occ('target', 'packages/b/src/target.ts', 'TGT'),
    );

    const out = buildEquivalenceDiagnostic({
      report: { productionDecline: [diff({ toA: 'TGT', toB: '' })], productionPhantom: [] },
      exact,
      sharded,
      shards: SHARDS,
    });

    expect(out.counts).toEqual({ productionDecline: 1, productionPhantom: 0 });
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
      { hash: 'TGT', occurrences: [expect.objectContaining({ simpleName: 'target' })] },
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
      report: { productionDecline: [], productionPhantom: [diff({ toA: '', toB: 'TGT' })] },
      exact,
      sharded,
      shards: SHARDS,
    });

    expect(out.counts).toEqual({ productionDecline: 0, productionPhantom: 1 });
    const p = out.phantom[0];
    expect(p.shardedEdge?.to).toEqual(['TGT']);
    expect(p.shardedTo).toEqual([
      { hash: 'TGT', occurrences: [expect.objectContaining({ simpleName: 'target' })] },
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
      report: { productionDecline: [diff({ toA: 'TGT', toB: '' })], productionPhantom: [] },
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
});
