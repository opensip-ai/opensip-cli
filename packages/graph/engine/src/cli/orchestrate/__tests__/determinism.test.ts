/**
 * Characterization test for cross-shard merge determinism (Phase 0).
 *
 * The shipping `graph` engine is the sharded per-package build. Shard
 * workers complete in nondeterministic order, so the orchestrator hands
 * `mergeAndResolveShards` a fragment array whose ORDER varies run to run.
 * The merged catalog MUST be a pure function of the fragment SET — the
 * same fragments in a different order must produce a structurally
 * identical catalog (same function keys, same per-occurrence edge sets,
 * same boundary stats). Anything order-dependent here is the determinism
 * drift Phase 3 must fix.
 *
 * This test builds two minimal fragments with a cross-boundary call
 * between them and runs `mergeAndResolveShards` with the fragments in both
 * orders, asserting structural equality. Any divergence is flagged with a
 * `// DRIFT:` comment as a characterization signal.
 */

import { describe, expect, it } from 'vitest';

import { mergeAndResolveShards } from '../cross-shard-resolve.js';

import type {
  CallEdge,
  Catalog,
  CrossBoundaryCall,
  FunctionOccurrence,
  ResolutionStats,
} from '../../../types.js';
import type { PackageManifestIndex } from '../export-index.js';
import type { ShardBuildResult } from '../shard-model.js';

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

function fragment(language: string, cacheKey: string, ...occs: FunctionOccurrence[]): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const o of occs) {
    const bucket = functions[o.simpleName];
    if (bucket) bucket.push(o);
    else functions[o.simpleName] = [o];
  }
  return {
    version: '3.0',
    tool: 'graph',
    language,
    builtAt: 'x',
    cacheKey,
    resolutionMode: 'exact',
    functions,
  };
}

function shard(
  shardId: string,
  fragment_: Catalog,
  boundaryCalls: readonly CrossBoundaryCall[] = [],
): ShardBuildResult {
  return {
    shardId,
    fragment: fragment_,
    fingerprint: `fp-${shardId}`,
    boundaryCalls,
    parseErrors: [],
  };
}

/**
 * Project a catalog to a canonical, order-insensitive structure: every
 * function name → every occurrence (by bodyHash) → its edge set normalized
 * to a sorted set of `line:col→sorted(to)` strings. Two catalogs that are
 * structurally identical (regardless of fragment input order) produce a
 * deep-equal projection.
 */
function structure(catalog: Catalog): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  for (const [name, occs] of Object.entries(catalog.functions)) {
    if (!occs) continue;
    const byHash: Record<string, string[]> = {};
    for (const o of occs) {
      byHash[o.bodyHash] = o.calls
        .map((e) => `${String(e.line)}:${String(e.column)}->${[...e.to].sort().join(',')}`)
        .sort();
    }
    out[name] = byHash;
  }
  return out;
}

function statsTuple(s: ResolutionStats): readonly number[] {
  return [s.totalCallSites, s.resolvedHigh, s.resolvedMedium, s.resolvedLow, s.unresolved];
}

describe('cross-shard merge determinism (characterization)', () => {
  // Two shards. pkg-a.caller() calls helperB(), exported by pkg-b, imported
  // via a bare workspace specifier — the canonical cross-boundary case.
  const shardA = shard(
    'pkg:a',
    fragment(
      'typescript',
      'key-a',
      occ('caller', 'packages/pkg-a/index.ts', 'A', [
        // Unresolved placeholder the local pass left at the boundary site.
        { to: [], line: 2, column: 9, resolution: 'unknown', confidence: 'low', text: 'helperB()' },
      ]),
    ),
    [
      {
        ownerHash: 'A',
        calleeName: 'helperB',
        importSpecifier: '@scope/pkgb',
        line: 2,
        column: 9,
        text: 'helperB()',
      },
    ],
  );
  const shardB = shard(
    'pkg:b',
    fragment('typescript', 'key-b', occ('helperB', 'packages/pkg-b/index.ts', 'B')),
  );
  const files = ['packages/pkg-a/index.ts', 'packages/pkg-b/index.ts'];
  // Maps the bare specifier `@scope/pkgb` → the pkg-b export bucket.
  const mIndex: PackageManifestIndex = new Map([
    ['@scope/pkgb', { name: '@scope/pkgb', dir: 'packages/pkg-b' }],
  ]);

  it('produces a structurally identical catalog regardless of fragment order', () => {
    const forward = mergeAndResolveShards([shardA, shardB], files, mIndex);
    const reversed = mergeAndResolveShards([shardB, shardA], files, mIndex);

    // Same function keys.
    expect(Object.keys(forward.catalog.functions).sort()).toEqual(
      Object.keys(reversed.catalog.functions).sort(),
    );

    // Same per-occurrence edge sets (order-normalized).
    // DRIFT: if this fails, the merge is order-dependent — the Phase-3 fix target.
    expect(structure(forward.catalog)).toEqual(structure(reversed.catalog));
  });

  it('produces identical boundary stats regardless of fragment order', () => {
    const forward = mergeAndResolveShards([shardA, shardB], files, mIndex);
    const reversed = mergeAndResolveShards([shardB, shardA], files, mIndex);

    // DRIFT: unequal stats would mean a boundary call resolved differently
    // depending on which shard merged first.
    expect(statsTuple(forward.boundaryStats)).toEqual(statsTuple(reversed.boundaryStats));
  });

  it('produces an order-independent merged cacheKey', () => {
    const forward = mergeAndResolveShards([shardA, shardB], files, mIndex);
    const reversed = mergeAndResolveShards([shardB, shardA], files, mIndex);

    // The build-level cacheKey is hashed from the SET of shard keys
    // (sorted), so it must not depend on completion order.
    // DRIFT: an order-sensitive cacheKey would thrash the merged-catalog cache.
    expect(forward.catalog.cacheKey).toBe(reversed.catalog.cacheKey);
  });

  it('keeps the same merged language for either order', () => {
    const forward = mergeAndResolveShards([shardA, shardB], files, mIndex);
    const reversed = mergeAndResolveShards([shardB, shardA], files, mIndex);
    expect(forward.catalog.language).toBe(reversed.catalog.language);
  });
});
