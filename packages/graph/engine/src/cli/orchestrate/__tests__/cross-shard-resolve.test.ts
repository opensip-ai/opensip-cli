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

function crossEdge(catalog: Catalog): CallEdge | undefined {
  return catalog.functions.caller?.[0]?.calls.find((e) => e.crossShard);
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

describe('mergeShardFragments — edge cases', () => {
  it('defaults the merged language to typescript for an empty fragment list', () => {
    const merged = mergeShardFragments([], []);
    expect(merged.language).toBe('typescript');
    expect(Object.keys(merged.functions)).toEqual([]);
  });

  it('dedups by (bodyHash, filePath, line) but keeps distinct occurrences of one name', () => {
    const merged = mergeShardFragments(
      [
        fragment('typescript', occ('handler', 'a.ts', 'A'), occ('handler', 'b.ts', 'B')),
        // Exact duplicate of the first → deduped.
        fragment('typescript', occ('handler', 'a.ts', 'A')),
      ],
      ['a.ts', 'b.ts'],
    );
    expect(merged.functions.handler).toHaveLength(2);
  });
});

describe('resolveCrossBoundaryCalls — ambiguity', () => {
  const merged = mergeShardFragments(
    [
      fragment('typescript', occ('mainA', 'pkgA/index.ts', 'A')),
      fragment('typescript', occ('dup', 'pkgB/index.ts', 'B1')),
      fragment('typescript', occ('dup', 'pkgC/index.ts', 'B2')),
    ],
    ['pkgA/index.ts', 'pkgB/index.ts', 'pkgC/index.ts'],
  );

  it('declines an ambiguous, unpinned name (two candidates, bare specifier)', () => {
    const bc: CrossBoundaryCall = {
      ownerHash: 'A',
      calleeName: 'dup', // two occurrences named 'dup'
      importSpecifier: '@scope/anything', // bare → not path-pinnable
      line: 2,
      column: 1,
      text: 'dup()',
    };
    const { catalog, boundaryStats } = resolveCrossBoundaryCalls(merged, [bc]);
    const edge = catalog.functions.mainA?.[0]?.calls.find((e) => e.crossShard);
    // Ambiguous + unpinned → declines (empty target) but is counted.
    expect(edge?.to).toEqual([]);
    expect(edge?.confidence).toBe('low');
    expect(boundaryStats.totalCallSites).toBe(1);
  });
});

describe('diffCatalogsByEdge', () => {
  it('reports an intra-shard edge difference when a non-cross edge target changed', () => {
    const a = mergeShardFragments(
      [fragment('typescript', occ('mainA', 'pkgA/index.ts', 'A', [
        { to: ['X'], line: 2, column: 1, resolution: 'static', confidence: 'high', text: 'x()' },
      ]))],
      ['pkgA/index.ts'],
    );
    const b = mergeShardFragments(
      [fragment('typescript', occ('mainA', 'pkgA/index.ts', 'A', [
        { to: ['Y'], line: 2, column: 1, resolution: 'static', confidence: 'high', text: 'x()' },
      ]))],
      ['pkgA/index.ts'],
    );
    const diff = diffCatalogsByEdge(a, b);
    expect(diff.intraMismatches.length).toBe(1);
    expect(diff.crossDifferences).toEqual([]);
  });

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

describe('resolveCrossBoundaryCalls — import-constrained (packages/ paths)', () => {
  function moduleInit(
    filePath: string,
    bodyHash: string,
    deps: readonly { to: readonly string[]; specifier: string }[],
  ): FunctionOccurrence {
    return {
      ...occ(`<module-init:${filePath}>`, filePath, bodyHash),
      kind: 'module-init',
      dependencies: deps.map((d) => ({ to: d.to, specifier: d.specifier, line: 1, column: 0 })),
    };
  }

  const callerA = occ('caller', 'packages/pkg-a/src/call.ts', 'CALLER');
  const fA = occ('f', 'packages/pkg-a/src/f.ts', 'FA');
  const fB = occ('f', 'packages/pkg-b/src/f.ts', 'FB');
  const gB = occ('g', 'packages/pkg-b/src/g.ts', 'G');
  const miB = moduleInit('packages/pkg-b/src/index.ts', 'MI_B', []);

  function mergedWith(callerModuleInit: FunctionOccurrence): Catalog {
    return mergeShardFragments(
      [
        fragment('typescript', callerA, fA, callerModuleInit),
        fragment('typescript', fB, gB, miB),
      ],
      ['packages/pkg-a/src/call.ts', 'packages/pkg-b/src/g.ts'],
    );
  }

  it("prefers the caller's own package for a same-named callee", () => {
    const miA = moduleInit('packages/pkg-a/src/call.ts', 'MI_A', [{ to: ['MI_B'], specifier: '@scope/pkgb' }]);
    const bc: CrossBoundaryCall = { ownerHash: 'CALLER', calleeName: 'f', importSpecifier: '@scope/pkgb', line: 2, column: 0, text: 'f()' };
    const { catalog } = resolveCrossBoundaryCalls(mergedWith(miA), [bc]);
    expect(crossEdge(catalog)?.to).toEqual(['FA']); // pkg-a's f, not pkg-b's
  });

  it('resolves into an imported package for a unique callee', () => {
    const miA = moduleInit('packages/pkg-a/src/call.ts', 'MI_A', [{ to: ['MI_B'], specifier: '@scope/pkgb' }]);
    const bc: CrossBoundaryCall = { ownerHash: 'CALLER', calleeName: 'g', importSpecifier: '@scope/pkgb', line: 2, column: 0, text: 'g()' };
    const { catalog } = resolveCrossBoundaryCalls(mergedWith(miA), [bc]);
    expect(crossEdge(catalog)?.to).toEqual(['G']);
  });

  it('declines a callee in a package the caller does not import', () => {
    const miA = moduleInit('packages/pkg-a/src/call.ts', 'MI_A', []); // imports nothing
    const bc: CrossBoundaryCall = { ownerHash: 'CALLER', calleeName: 'g', importSpecifier: '@scope/pkgb', line: 2, column: 0, text: 'g()' };
    const { catalog } = resolveCrossBoundaryCalls(mergedWith(miA), [bc]);
    expect(crossEdge(catalog)?.to).toEqual([]); // declined — pkg-b not imported
  });
});
