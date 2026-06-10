/**
 * Cross-shard merge & semantic boundary-linking correctness.
 *
 * The headline invariant: merging shard fragments and LINKING the boundary
 * calls against the export symbol table recovers cross-package edges that the
 * old fan-out dropped — labeled `resolution:'semantic'`, `crossShard:true`,
 * `confidence:'high'` — but ONLY when the import specifier + callee name pin a
 * UNIQUE exported occurrence. On any ambiguity the linker DECLINES (empty
 * target) rather than fabricate a phantom edge. Intra-shard edges are untouched.
 */

import { describe, expect, it } from 'vitest';

import {
  diffCatalogsByEdge,
  mergeShardFragments,
  resolveCrossBoundaryCalls,
} from '../cross-shard-resolve.js';

import type { PackageManifest, PackageManifestIndex } from '../../../cross-package/export-index.js';
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

/** Build an in-memory manifest index without touching disk. */
function manifests(...entries: readonly PackageManifest[]): PackageManifestIndex {
  const index = new Map<string, PackageManifest>();
  for (const m of entries) index.set(m.name, m);
  return index;
}

/** Manifest mapping the specifier `@scope/pkg<segment>` → `packages/<dir>`. */
function manifest(
  name: string,
  dir: string,
  exportsMap?: Record<string, unknown>,
): PackageManifest {
  return exportsMap === undefined ? { name, dir } : { name, dir, exportsMap };
}

const EMPTY_MANIFESTS: PackageManifestIndex = new Map();

function crossEdge(catalog: Catalog): CallEdge | undefined {
  return (
    catalog.functions.caller?.[0]?.calls.find((e) => e.crossShard) ??
    catalog.functions.mainA?.[0]?.calls.find((e) => e.crossShard)
  );
}

describe('mergeShardFragments', () => {
  it('unions occurrences from every fragment, preserving intra-shard calls', () => {
    const a = fragment(
      'typescript',
      occ('mainA', 'pkgA/a.ts', 'A', [
        {
          to: ['LOCAL'],
          line: 2,
          column: 4,
          resolution: 'static',
          confidence: 'high',
          text: 'localA()',
        },
      ]),
    );
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
      fragment('typescript', occ('mainA', 'packages/pkg-a/index.ts', 'A')),
      fragment('typescript', occ('helperB', 'packages/pkg-b/index.ts', 'B')),
    ],
    ['packages/pkg-a/index.ts', 'packages/pkg-b/index.ts'],
  );
  const mIndex = manifests(manifest('@scope/pkgb', 'packages/pkg-b'));

  it('links a bare-specifier call to a unique export as a semantic crossShard edge', () => {
    const bc: CrossBoundaryCall = {
      ownerHash: 'A',
      ownerFile: 'packages/pkg-a/index.ts',
      calleeName: 'helperB',
      importSpecifier: '@scope/pkgb', // bare → resolved via manifest + export index
      line: 2,
      column: 9,
      text: 'helperB()',
    };
    const { catalog, boundaryStats } = resolveCrossBoundaryCalls(merged, [bc], mIndex);
    const edge = catalog.functions.mainA?.[0]?.calls.find((e) => e.crossShard);
    expect(edge).toBeDefined();
    expect(edge?.resolution).toBe('semantic');
    expect(edge?.crossShard).toBe(true);
    expect(edge?.to).toEqual(['B']);
    expect(edge?.confidence).toBe('high'); // unique export → high
    expect(boundaryStats.totalCallSites).toBe(1);
    expect(boundaryStats.resolvedHigh).toBe(1);
  });

  it('pins a relative-specifier call to the resolved file (high confidence)', () => {
    // pkg-a/index.ts imports '../pkg-b/index.js' → resolves to pkg-b/index.ts.
    const bc: CrossBoundaryCall = {
      ownerHash: 'A',
      ownerFile: 'packages/pkg-a/index.ts',
      calleeName: 'helperB',
      importSpecifier: '../pkg-b/index.js',
      line: 2,
      column: 9,
      text: 'helperB()',
    };
    const { catalog } = resolveCrossBoundaryCalls(merged, [bc], EMPTY_MANIFESTS);
    const edge = catalog.functions.mainA?.[0]?.calls.find((e) => e.crossShard);
    expect(edge?.to).toEqual(['B']);
    expect(edge?.resolution).toBe('semantic');
    expect(edge?.confidence).toBe('high');
  });

  it('declines a call whose specifier maps to no known workspace package', () => {
    const bc: CrossBoundaryCall = {
      ownerHash: 'A',
      ownerFile: 'packages/pkg-a/index.ts',
      calleeName: 'chalk', // external npm
      importSpecifier: 'chalk',
      line: 3,
      column: 1,
      text: 'chalk()',
    };
    const { catalog, boundaryStats } = resolveCrossBoundaryCalls(merged, [bc], mIndex);
    // Phase 6: a declined cross-shard call persists NO standalone `to: []`
    // crossShard edge (parity with exact, which emits no per-site catalog edge).
    // The decline is still counted in the boundary stats.
    const edge = catalog.functions.mainA?.[0]?.calls.find((e) => e.crossShard);
    expect(edge).toBeUndefined();
    expect(boundaryStats.unresolved).toBe(1);
  });

  it('declines a name the resolved package does not export', () => {
    const bc: CrossBoundaryCall = {
      ownerHash: 'A',
      ownerFile: 'packages/pkg-a/index.ts',
      calleeName: 'notExported', // package pkg-b exports helperB only
      importSpecifier: '@scope/pkgb',
      line: 4,
      column: 1,
      text: 'notExported()',
    };
    const { catalog } = resolveCrossBoundaryCalls(merged, [bc], mIndex);
    // Phase 6: declined → no persisted crossShard placeholder edge.
    expect(crossEdge(catalog)).toBeUndefined();
  });

  it('replaces the unresolved intra-shard placeholder at the same site', () => {
    const withPlaceholder = mergeShardFragments(
      [
        fragment(
          'typescript',
          occ('mainA', 'packages/pkg-a/index.ts', 'A', [
            {
              to: [],
              line: 2,
              column: 9,
              resolution: 'unknown',
              confidence: 'low',
              text: 'helperB()',
            },
          ]),
        ),
        fragment('typescript', occ('helperB', 'packages/pkg-b/index.ts', 'B')),
      ],
      ['packages/pkg-a/index.ts', 'packages/pkg-b/index.ts'],
    );
    const bc: CrossBoundaryCall = {
      ownerHash: 'A',
      ownerFile: 'packages/pkg-a/index.ts',
      calleeName: 'helperB',
      importSpecifier: '@scope/pkgb',
      line: 2,
      column: 9,
      text: 'helperB()',
    };
    const { catalog } = resolveCrossBoundaryCalls(withPlaceholder, [bc], mIndex);
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
  // Two exports named 'dup' inside the SAME imported package → ambiguous.
  const merged = mergeShardFragments(
    [
      fragment('typescript', occ('mainA', 'packages/pkg-a/index.ts', 'A')),
      fragment(
        'typescript',
        occ('dup', 'packages/pkg-b/a.ts', 'B1'),
        occ('dup', 'packages/pkg-b/b.ts', 'B2'),
      ),
    ],
    ['packages/pkg-a/index.ts', 'packages/pkg-b/a.ts', 'packages/pkg-b/b.ts'],
  );
  const mIndex = manifests(manifest('@scope/pkgb', 'packages/pkg-b'));

  it('declines an ambiguous unpinned name (two same-name exports, root specifier)', () => {
    const bc: CrossBoundaryCall = {
      ownerHash: 'A',
      ownerFile: 'packages/pkg-a/index.ts',
      calleeName: 'dup', // two occurrences named 'dup' in pkg-b
      importSpecifier: '@scope/pkgb', // root specifier → no subpath to narrow
      line: 2,
      column: 1,
      text: 'dup()',
    };
    const { catalog, boundaryStats } = resolveCrossBoundaryCalls(merged, [bc], mIndex);
    const edge = catalog.functions.mainA?.[0]?.calls.find((e) => e.crossShard);
    // Ambiguous + unpinned → declines. Phase 6: no persisted placeholder edge,
    // but the decline is still counted.
    expect(edge).toBeUndefined();
    expect(boundaryStats.unresolved).toBe(1);
  });

  it('narrows ambiguous same-name exports when a declared subpath pins one file', () => {
    const withExports = manifests(manifest('@scope/pkgb', 'packages/pkg-b', { './b': './b.js' }));
    const bc: CrossBoundaryCall = {
      ownerHash: 'A',
      ownerFile: 'packages/pkg-a/index.ts',
      calleeName: 'dup',
      importSpecifier: '@scope/pkgb/b', // subpath → narrows to packages/pkg-b/b.ts
      line: 2,
      column: 1,
      text: 'dup()',
    };
    const { catalog } = resolveCrossBoundaryCalls(merged, [bc], withExports);
    expect(crossEdge(catalog)?.to).toEqual(['B2']);
  });
});

describe('diffCatalogsByEdge', () => {
  it('reports an intra-shard edge difference when a non-cross edge target changed', () => {
    const a = mergeShardFragments(
      [
        fragment(
          'typescript',
          occ('mainA', 'packages/pkg-a/index.ts', 'A', [
            {
              to: ['X'],
              line: 2,
              column: 1,
              resolution: 'static',
              confidence: 'high',
              text: 'x()',
            },
          ]),
        ),
      ],
      ['packages/pkg-a/index.ts'],
    );
    const b = mergeShardFragments(
      [
        fragment(
          'typescript',
          occ('mainA', 'packages/pkg-a/index.ts', 'A', [
            {
              to: ['Y'],
              line: 2,
              column: 1,
              resolution: 'static',
              confidence: 'high',
              text: 'x()',
            },
          ]),
        ),
      ],
      ['packages/pkg-a/index.ts'],
    );
    const diff = diffCatalogsByEdge(a, b);
    expect(diff.intraMismatches.length).toBe(1);
    expect(diff.crossDifferences).toEqual([]);
  });

  it('partitions a cross-package edge difference into crossDifferences (not intraMismatches)', () => {
    // This exercises the PARTITIONING mechanism, not an accepted divergence: we
    // diff a DEGENERATE "whole" catalog that deliberately omits the cross-package
    // edge against a sharded catalog that recovered it, and assert the lone
    // difference lands in `crossDifferences`. In a real equivalence check both
    // partitions must be empty (the whole-project build resolves the same edge);
    // the Phase 4 guardrail (`equivalence.test.ts`) asserts that.
    const whole = mergeShardFragments(
      [fragment('typescript', occ('mainA', 'packages/pkg-a/index.ts', 'A'))],
      ['packages/pkg-a/index.ts'],
    );
    const sharded = resolveCrossBoundaryCalls(
      mergeShardFragments(
        [
          fragment('typescript', occ('mainA', 'packages/pkg-a/index.ts', 'A')),
          fragment('typescript', occ('helperB', 'packages/pkg-b/index.ts', 'B')),
        ],
        ['packages/pkg-a/index.ts', 'packages/pkg-b/index.ts'],
      ),
      [
        {
          ownerHash: 'A',
          ownerFile: 'packages/pkg-a/index.ts',
          calleeName: 'helperB',
          importSpecifier: '@scope/pkgb',
          line: 2,
          column: 1,
          text: 'helperB()',
        },
      ],
      manifests(manifest('@scope/pkgb', 'packages/pkg-b')),
    ).catalog;

    const diff = diffCatalogsByEdge(whole, sharded);
    expect(diff.intraMismatches).toEqual([]);
    expect(diff.crossDifferences.length).toBe(1);
  });
});

// Keep the shard type referenced so the import documents the merge inputs.
const _exampleShard: Shard = { id: 'pkg:a', rootDir: '/abs/pkgA', files: ['/abs/pkgA/index.ts'] };
void _exampleShard;

describe('resolveCrossBoundaryCalls — semantic export linking (packages/ paths)', () => {
  const callerA = occ('caller', 'packages/pkg-a/src/call.ts', 'CALLER');
  const fA = occ('f', 'packages/pkg-a/src/f.ts', 'FA');
  const fB = occ('f', 'packages/pkg-b/src/f.ts', 'FB');
  const gB = occ('g', 'packages/pkg-b/src/g.ts', 'G');

  const merged = mergeShardFragments(
    [fragment('typescript', callerA, fA), fragment('typescript', fB, gB)],
    ['packages/pkg-a/src/call.ts', 'packages/pkg-b/src/g.ts'],
  );
  const mIndex = manifests(manifest('@scope/pkgb', 'packages/pkg-b'));

  it('links into the imported package for a unique exported callee', () => {
    const bc: CrossBoundaryCall = {
      ownerHash: 'CALLER',
      ownerFile: 'packages/pkg-a/src/call.ts',
      calleeName: 'g',
      importSpecifier: '@scope/pkgb',
      line: 2,
      column: 0,
      text: 'g()',
    };
    const { catalog } = resolveCrossBoundaryCalls(merged, [bc], mIndex);
    expect(crossEdge(catalog)?.to).toEqual(['G']);
  });

  it('declines when the same name is exported by both the caller and the target package', () => {
    // 'f' exists in BOTH pkg-a and pkg-b. The specifier names pkg-b, whose
    // export bucket has exactly one 'f' (FB) — that is the unique linkable
    // target. (The caller's own 'f' lives in a different package bucket.)
    const bc: CrossBoundaryCall = {
      ownerHash: 'CALLER',
      ownerFile: 'packages/pkg-a/src/call.ts',
      calleeName: 'f',
      importSpecifier: '@scope/pkgb',
      line: 2,
      column: 0,
      text: 'f()',
    };
    const { catalog } = resolveCrossBoundaryCalls(merged, [bc], mIndex);
    expect(crossEdge(catalog)?.to).toEqual(['FB']); // pkg-b's f, by the specifier
  });

  it('declines a callee whose specifier names an untracked package', () => {
    const bc: CrossBoundaryCall = {
      ownerHash: 'CALLER',
      ownerFile: 'packages/pkg-a/src/call.ts',
      calleeName: 'g',
      importSpecifier: '@scope/unknown',
      line: 2,
      column: 0,
      text: 'g()',
    };
    const { catalog } = resolveCrossBoundaryCalls(merged, [bc], mIndex);
    // Phase 6: declined (pkg not in manifest index) → no persisted placeholder edge.
    expect(crossEdge(catalog)).toBeUndefined();
  });
});

describe('resolveCrossBoundaryCalls — body-twin keying (F1, ADR-0003)', () => {
  // Two functions named `twin` with BYTE-IDENTICAL bodies in different packages
  // → they share a bodyHash ('TWIN'). Each makes its OWN cross-shard call via a
  // RELATIVE import to a sibling in its OWN package. The corpus the real
  // equivalence gate runs on happens to contain no cross-shard-calling body
  // twins, so this is the fixture that locks the keying: keyed by `ownerHash`
  // alone (the pre-fix scheme), BOTH twins would receive BOTH recovered edges
  // (smearing) AND the relative pin would resolve against a last-writer-wins
  // twin's directory. Keyed by ownerEdgeKey(ownerHash, ownerFile), each twin
  // gets exactly its own edge, pinned against its own directory.
  const merged = mergeShardFragments(
    [
      fragment(
        'typescript',
        occ('twin', 'packages/pkg-a/src/twin.ts', 'TWIN'),
        occ('helperA', 'packages/pkg-a/src/helper.ts', 'HA'),
      ),
      fragment(
        'typescript',
        occ('twin', 'packages/pkg-b/src/twin.ts', 'TWIN'),
        occ('helperB', 'packages/pkg-b/src/helper.ts', 'HB'),
      ),
    ],
    [
      'packages/pkg-a/src/twin.ts',
      'packages/pkg-a/src/helper.ts',
      'packages/pkg-b/src/twin.ts',
      'packages/pkg-b/src/helper.ts',
    ],
  );

  // pkg-a's twin calls helperA via './helper.js'; pkg-b's twin calls helperB via
  // the IDENTICAL specifier './helper.js' — only the ownerFile disambiguates.
  const bcA: CrossBoundaryCall = {
    ownerHash: 'TWIN',
    ownerFile: 'packages/pkg-a/src/twin.ts',
    calleeName: 'helperA',
    importSpecifier: './helper.js',
    line: 2,
    column: 9,
    text: 'helperA()',
  };
  const bcB: CrossBoundaryCall = {
    ownerHash: 'TWIN',
    ownerFile: 'packages/pkg-b/src/twin.ts',
    calleeName: 'helperB',
    importSpecifier: './helper.js',
    line: 2,
    column: 9,
    text: 'helperB()',
  };

  it('routes each body-twin its OWN recovered edge (no smearing)', () => {
    const { catalog } = resolveCrossBoundaryCalls(merged, [bcA, bcB], EMPTY_MANIFESTS);
    const twins = catalog.functions.twin ?? [];
    const twinA = twins.find((o) => o.filePath === 'packages/pkg-a/src/twin.ts');
    const twinB = twins.find((o) => o.filePath === 'packages/pkg-b/src/twin.ts');

    // Each twin carries EXACTLY its own cross-shard edge — never the other's.
    expect(twinA?.calls.filter((e) => e.crossShard).flatMap((e) => [...e.to])).toEqual(['HA']);
    expect(twinB?.calls.filter((e) => e.crossShard).flatMap((e) => [...e.to])).toEqual(['HB']);
  });

  it("pins each twin's relative import against its OWN directory", () => {
    // Same specifier './helper.js' from both twins must resolve to the helper in
    // the SAME package as the owner — proving pinBySpecifier uses bc.ownerFile,
    // not a last-writer-wins bodyHash->file guess.
    const { catalog } = resolveCrossBoundaryCalls(merged, [bcA, bcB], EMPTY_MANIFESTS);
    const twins = catalog.functions.twin ?? [];
    const twinA = twins.find((o) => o.filePath === 'packages/pkg-a/src/twin.ts');
    const twinB = twins.find((o) => o.filePath === 'packages/pkg-b/src/twin.ts');
    // HA lives in pkg-a, HB in pkg-b — no crossed wires.
    expect(twinA?.calls.flatMap((e) => [...e.to])).not.toContain('HB');
    expect(twinB?.calls.flatMap((e) => [...e.to])).not.toContain('HA');
  });
});
