/**
 * Cross-shard merge & boundary-resolution correctness.
 *
 * The headline invariant: merging shard fragments and resolving the
 * boundary calls recovers cross-package edges that the old fan-out
 * dropped — labeled `resolution:'syntactic'`, `crossShard:true`,
 * confidence ≤ 'medium' — while intra-shard edges are untouched.
 */

import { describe, expect, it } from 'vitest';

import {
  diffCatalogsByEdge,
  mergeShardFragments,
  resolveCrossBoundaryCalls,
} from '../cross-shard-resolve.js';

import type { Catalog, CallEdge, CrossBoundaryCall, FunctionOccurrence } from '../../../types.js';
import type { Shard } from '../shard-model.js';

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

function fragment(language: string, ...occs: FunctionOccurrence[]): Catalog {
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
    cacheKey: `key-${language}`,
    resolutionMode: 'exact',
    functions,
  };
}

describe('mergeShardFragments', () => {
  it('unions occurrences from every fragment, preserving intra-shard calls', () => {
    const a = fragment('typescript', occ('mainA', 'pkgA/a.ts', 'A', [
      { to: ['LOCAL'], line: 2, column: 4, resolution: 'static', confidence: 'high', text: 'localA()' },
    ]));
    const b = fragment('typescript', occ('helperB', 'pkgB/b.ts', 'B'));
    const merged = mergeShardFragments([a, b], ['pkgA/a.ts', 'pkgB/b.ts']);

    expect(Object.keys(merged.functions).sort()).toEqual(['helperB', 'mainA']);
    expect(merged.functions.mainA?.[0]?.calls[0]?.to).toEqual(['LOCAL']);
    expect(merged.resolutionMode).toBe('exact');
  });

  it('dedups an occurrence that appears in two fragments', () => {
    const dup = occ('shared', 'common.ts', 'H');
    const merged = mergeShardFragments(
      [fragment('typescript', dup), fragment('typescript', dup)],
      ['common.ts'],
    );
    expect(merged.functions.shared).toHaveLength(1);
  });
});

describe('resolveCrossBoundaryCalls', () => {
  const merged = mergeShardFragments(
    [
      fragment('typescript', occ('mainA', 'pkgA/index.ts', 'A')),
      fragment('typescript', occ('helperB', 'pkgB/index.ts', 'B')),
    ],
    ['pkgA/index.ts', 'pkgB/index.ts'],
  );

  it('recovers a cross-package call as a syntactic crossShard edge', () => {
    const bc: CrossBoundaryCall = {
      ownerHash: 'A',
      calleeName: 'helperB',
      importSpecifier: '@scope/pkgb', // bare → name-only
      line: 2,
      column: 9,
      text: 'helperB()',
    };
    const { catalog, boundaryStats } = resolveCrossBoundaryCalls(merged, [bc]);
    const edge = catalog.functions.mainA?.[0]?.calls.find((e) => e.crossShard);
    expect(edge).toBeDefined();
    expect(edge?.resolution).toBe('syntactic');
    expect(edge?.crossShard).toBe(true);
    expect(edge?.to).toEqual(['B']);
    expect(edge?.confidence).toBe('low'); // bare specifier → name-only → low
    expect(edge?.confidence).not.toBe('high');
    expect(boundaryStats.totalCallSites).toBe(1);
    expect(boundaryStats.resolvedHigh).toBe(0);
  });

  it('pins a relative-specifier call to medium confidence', () => {
    // pkgA/index.ts imports '../pkgB/index.js' → resolves to pkgB/index.ts.
    const bc: CrossBoundaryCall = {
      ownerHash: 'A',
      calleeName: 'helperB',
      importSpecifier: '../pkgB/index.js',
      line: 2,
      column: 9,
      text: 'helperB()',
    };
    const { catalog } = resolveCrossBoundaryCalls(merged, [bc]);
    const edge = catalog.functions.mainA?.[0]?.calls.find((e) => e.crossShard);
    expect(edge?.to).toEqual(['B']);
    expect(edge?.confidence).toBe('medium');
  });

  it('leaves a genuinely external call unresolved but attributable', () => {
    const bc: CrossBoundaryCall = {
      ownerHash: 'A',
      calleeName: 'chalk', // not in the merged catalog
      importSpecifier: 'chalk',
      line: 3,
      column: 1,
      text: 'chalk()',
    };
    const { catalog, boundaryStats } = resolveCrossBoundaryCalls(merged, [bc]);
    const edge = catalog.functions.mainA?.[0]?.calls.find((e) => e.crossShard);
    expect(edge?.to).toEqual([]);
    expect(boundaryStats.unresolved).toBe(1);
  });

  it('replaces the unresolved intra-shard placeholder at the same site', () => {
    const withPlaceholder = mergeShardFragments(
      [
        fragment(
          'typescript',
          occ('mainA', 'pkgA/index.ts', 'A', [
            { to: [], line: 2, column: 9, resolution: 'unknown', confidence: 'low', text: 'helperB()' },
          ]),
        ),
        fragment('typescript', occ('helperB', 'pkgB/index.ts', 'B')),
      ],
      ['pkgA/index.ts', 'pkgB/index.ts'],
    );
    const bc: CrossBoundaryCall = {
      ownerHash: 'A',
      calleeName: 'helperB',
      importSpecifier: '@scope/pkgb',
      line: 2,
      column: 9,
      text: 'helperB()',
    };
    const { catalog } = resolveCrossBoundaryCalls(withPlaceholder, [bc]);
    const calls = catalog.functions.mainA?.[0]?.calls ?? [];
    // Exactly one edge at line 2:9 — the recovered one, not the placeholder.
    expect(calls.filter((e) => e.line === 2 && e.column === 9)).toHaveLength(1);
    expect(calls[0]?.crossShard).toBe(true);
  });
});

describe('diffCatalogsByEdge', () => {
  it('reports zero intra mismatches and the cross-shard difference', () => {
    const whole = mergeShardFragments(
      [fragment('typescript', occ('mainA', 'pkgA/index.ts', 'A'))],
      ['pkgA/index.ts'],
    );
    const sharded = resolveCrossBoundaryCalls(
      mergeShardFragments(
        [
          fragment('typescript', occ('mainA', 'pkgA/index.ts', 'A')),
          fragment('typescript', occ('helperB', 'pkgB/index.ts', 'B')),
        ],
        ['pkgA/index.ts', 'pkgB/index.ts'],
      ),
      [{ ownerHash: 'A', calleeName: 'helperB', importSpecifier: '@x/b', line: 2, column: 1, text: 'helperB()' }],
    ).catalog;

    const diff = diffCatalogsByEdge(whole, sharded);
    expect(diff.intraMismatches).toEqual([]);
    expect(diff.crossDifferences.length).toBe(1);
  });
});

// Keep the shard type referenced so the import documents the merge inputs.
const _exampleShard: Shard = { id: 'pkg:a', rootDir: '/abs/pkgA', files: ['/abs/pkgA/index.ts'] };
void _exampleShard;
