import { describe, expect, it } from 'vitest';

import {
  buildComputeImpactIndex,
  computeImpact as computeImpactSync,
  computeImpactAsync as computeImpact,
  computeImpactCatalogGenerationIdentity,
  ComputeImpactCancelledError,
  type GraphCatalog,
  type GraphFunctionOccurrence,
} from '../index.js';

function minimalCatalog(): GraphCatalog {
  return {
    version: '2.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-01-01T00:00:00.000Z',
    cacheKey: 'test-cache',
    filesFingerprint: 'test-fingerprint',
    functions: {
      caller: [
        {
          // bodyHash is a content hash, deliberately DISTINCT from qualifiedName
          // (in production it is a sha256, never the dotted symbol name). Edges
          // reference callees by bodyHash — see `to: ['hash-callee']` below.
          bodyHash: 'hash-caller',
          qualifiedName: 'caller',
          simpleName: 'caller',
          filePath: 'src/caller.ts',
          line: 1,
          column: 1,
          endLine: 5,
          kind: 'function-declaration',
          visibility: 'exported',
          inTestFile: false,
          definedInGenerated: false,
          params: [],
          returnType: null,
          enclosingClass: null,
          decorators: [],
          calls: [
            {
              to: ['hash-callee'],
              line: 2,
              column: 4,
              resolution: 'static',
              confidence: 'high',
              text: 'callee()',
            },
          ],
        },
      ],
      callee: [
        {
          bodyHash: 'hash-callee',
          qualifiedName: 'callee',
          simpleName: 'callee',
          filePath: 'src/callee.ts',
          line: 1,
          column: 1,
          endLine: 5,
          kind: 'function-declaration',
          visibility: 'exported',
          inTestFile: false,
          definedInGenerated: false,
          params: [],
          returnType: null,
          enclosingClass: null,
          decorators: [],
          calls: [],
        },
      ],
    },
  };
}

/**
 * A linear caller chain: f0 ← f1 ← f2 ← … (each `fN` calls `f{N-1}`), one
 * function per file. Reverse-BFS from a changed `f0` walks up the chain one
 * depth per hop, so it exercises the `maxDepth` bound.
 */
function chainCatalog(length: number): GraphCatalog {
  const functions: Record<string, GraphFunctionOccurrence[]> = {};
  for (let i = 0; i < length; i++) {
    functions[`f${i}`] = [
      {
        // bodyHash distinct from qualifiedName (see minimalCatalog note).
        bodyHash: `hash-f${i}`,
        qualifiedName: `f${i}`,
        simpleName: `f${i}`,
        filePath: `src/f${i}.ts`,
        line: 1,
        column: 1,
        endLine: 5,
        kind: 'function-declaration',
        visibility: 'exported',
        inTestFile: false,
        definedInGenerated: false,
        params: [],
        returnType: null,
        enclosingClass: null,
        decorators: [],
        // fN calls f(N-1); reverse adjacency makes f(N) a caller of f(N-1).
        calls:
          i === 0
            ? []
            : [
                {
                  to: [`hash-f${i - 1}`],
                  line: 2,
                  column: 4,
                  resolution: 'static',
                  confidence: 'high',
                  text: `f${i - 1}()`,
                },
              ],
      },
    ];
  }
  return {
    version: '2.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-01-01T00:00:00.000Z',
    cacheKey: 'test-cache',
    filesFingerprint: 'test-fingerprint',
    functions,
  };
}

function wideChangedCatalog(length: number): GraphCatalog {
  const source = chainCatalog(length);
  return {
    ...source,
    functions: Object.fromEntries(
      Object.entries(source.functions).map(([name, occurrences]) => [
        name,
        occurrences.map((occurrence) => ({
          ...occurrence,
          filePath: 'src/wide.ts',
          calls: [],
        })),
      ]),
    ),
  };
}

describe('computeImpact', () => {
  it('preserves the original synchronous public API', async () => {
    const synchronous = computeImpactSync(minimalCatalog(), ['src/callee.ts']);
    expect(synchronous).not.toBeInstanceOf(Promise);
    expect(synchronous).toEqual(await computeImpact(minimalCatalog(), ['src/callee.ts']));
  });

  it('stops the reverse-BFS at maxDepth', async () => {
    // Chain f0..f6; change f0. With maxDepth 2, only f1 (depth 1) and f2
    // (depth 2) are impacted — f3..f6 lie beyond the bound.
    const r = await computeImpact(chainCatalog(7), ['src/f0.ts'], {
      maxDepth: 2,
    });
    const names = r.impactedFunctions.map((f) => f.qualifiedName).sort();
    expect(names).toEqual(['f1', 'f2']);
  });

  it('walks the full chain when maxDepth is generous', async () => {
    const r = await computeImpact(chainCatalog(7), ['src/f0.ts'], {
      maxDepth: 10,
    });
    const names = r.impactedFunctions.map((f) => f.qualifiedName).sort();
    expect(names).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
  });

  it('finds changed functions and reverse callers', async () => {
    const r = await computeImpact(minimalCatalog(), ['src/callee.ts']);
    expect(r.changedFunctions).toHaveLength(1);
    expect(r.changedFunctions[0]?.qualifiedName).toBe('callee');
    expect(r.impactedFunctions.some((f) => f.qualifiedName === 'caller')).toBe(true);
    expect(r.impactedFiles).toEqual(['src/callee.ts', 'src/caller.ts']);
    expect(r.trust).toMatchObject({
      coverage: 'full',
      fallback: 'targeted',
      fullyVerified: true,
    });
  });

  it('preserves every impacted caller occurrence that shares a body hash', async () => {
    const base = minimalCatalog();
    const caller = base.functions.caller[0];
    const catalog: GraphCatalog = {
      ...base,
      functions: {
        caller: [
          { ...caller, filePath: 'packages/a/src/caller.ts', package: 'a' },
          { ...caller, filePath: 'packages/b/src/caller.ts', package: 'b' },
        ],
        callee: base.functions.callee,
      },
    };
    const result = await computeImpact(catalog, ['src/callee.ts']);
    expect(result.impactedFunctions).toEqual([
      expect.objectContaining({
        filePath: 'packages/a/src/caller.ts',
        package: 'a',
      }),
      expect.objectContaining({
        filePath: 'packages/b/src/caller.ts',
        package: 'b',
      }),
    ]);
    expect(result.impactedFiles).toEqual([
      'packages/a/src/caller.ts',
      'packages/b/src/caller.ts',
      'src/callee.ts',
    ]);
    expect(result.impactedPackages).toEqual(
      expect.arrayContaining([
        { name: 'a', functionCount: 1 },
        { name: 'b', functionCount: 1 },
      ]),
    );
  });

  it('preserves results when a caller reuses a generation-owned index', async () => {
    const catalog = chainCatalog(7);
    const index = await buildComputeImpactIndex(catalog);
    const expected = await computeImpact(catalog, ['src/f0.ts'], {
      maxDepth: 3,
    });
    const actual = await computeImpact(catalog, ['src/f0.ts'], {
      maxDepth: 3,
      index,
    });
    expect(index.sourceCatalog).toBe(catalog);
    expect(actual).toEqual(expected);
  });

  it('accepts an independently decoded copy of the same indexed generation', async () => {
    const catalog = chainCatalog(4);
    const copy = structuredClone(catalog);
    await expect(
      computeImpact(copy, ['src/f0.ts'], {
        index: await buildComputeImpactIndex(catalog),
      }),
    ).resolves.toEqual(await computeImpact(copy, ['src/f0.ts']));
  });

  it('fails closed when a caller supplies an index from another generation', async () => {
    const catalog = chainCatalog(4);
    const other: GraphCatalog = {
      ...catalog,
      filesFingerprint: 'other-generation',
    };
    await expect(
      computeImpact(other, ['src/f0.ts'], {
        index: await buildComputeImpactIndex(catalog),
      }),
    ).rejects.toThrow(/different graph catalog generation/u);
  });

  it('rejects immediately when impact work is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      computeImpact(chainCatalog(300), ['src/f0.ts'], {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ComputeImpactCancelledError);
  });

  it('cancels index construction after the request has started', async () => {
    const controller = new AbortController();
    const pending = buildComputeImpactIndex(chainCatalog(10_000), controller.signal);
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toBeInstanceOf(ComputeImpactCancelledError);
  });

  it('cancels structural generation hashing after it has started', async () => {
    const controller = new AbortController();
    const pending = computeImpactCatalogGenerationIdentity(chainCatalog(10_000), controller.signal);
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toBeInstanceOf(ComputeImpactCancelledError);
  });

  it('omits unsafe catalog scalars from every public impact row', async () => {
    const source = minimalCatalog();
    const caller = source.functions.caller[0];
    const repeat = (overrides: Partial<GraphFunctionOccurrence>): GraphFunctionOccurrence => ({
      ...caller,
      ...overrides,
    });
    const catalog: GraphCatalog = {
      ...source,
      functions: {
        caller: [
          repeat({ filePath: `src/${'p'.repeat(1024)}.ts` }),
          repeat({ filePath: 'src/control\npath.ts' }),
          repeat({ qualifiedName: 'control\nname' }),
          repeat({ qualifiedName: 'n'.repeat(1025) }),
          repeat({ package: 'control\npackage' }),
          repeat({ package: 'p'.repeat(215) }),
        ],
        callee: source.functions.callee,
      },
    };
    const result = await computeImpact(catalog, ['src/callee.ts']);
    expect(result.changedFunctions).toHaveLength(1);
    expect(result.impactedFunctions).toEqual([]);
    expect(result.impactedFiles).toEqual(['src/callee.ts']);
    expect(result.trust.uncertainties).toContainEqual(
      expect.objectContaining({ code: 'impact-malformed-row-omitted' }),
    );
  });

  it('honors top cap and sets truncated', async () => {
    const r = await computeImpact(minimalCatalog(), ['src/callee.ts'], {
      top: 1,
    });
    expect(r.truncated).toBe(true);
    expect(r.trust.fullyVerified).toBe(false);
    expect(r.trust.uncertainties.map((item) => item.code)).toContain('impact-truncated');
  });

  it('bounds changed rows before projecting a file with more than 500 functions', async () => {
    const result = await computeImpact(wideChangedCatalog(650), ['src/wide.ts'], { top: 500 });
    expect(result.changedFunctions).toHaveLength(500);
    expect(result.impactedFunctions).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(result.trust).toMatchObject({ fullyVerified: false });
    expect(result.trust.uncertainties).toContainEqual(
      expect.objectContaining({ code: 'impact-truncated' }),
    );
  });

  it('does not truncate when the top cap covers the full result', async () => {
    const r = await computeImpact(minimalCatalog(), ['src/callee.ts'], {
      top: 10,
    });
    expect(r.truncated).toBe(false);
    expect(r.impactedFunctions).toHaveLength(1);
  });

  it('treats negative top caps as uncapped for forward-compatible callers', async () => {
    const r = await computeImpact(minimalCatalog(), ['src/callee.ts'], {
      top: -1,
    });
    expect(r.truncated).toBe(false);
    expect(r.impactedFunctions).toHaveLength(1);
  });

  it('normalizes changed file paths before matching catalog occurrences', async () => {
    const r = await computeImpact(minimalCatalog(), ['src\\callee.ts']);
    expect(r.changedFunctions.map((f) => f.qualifiedName)).toEqual(['callee']);
  });

  it('classifies impacted callers with blast and test-gap reasons', async () => {
    const blastCatalog: GraphCatalog = {
      ...minimalCatalog(),
      features: {
        function: {
          'hash-caller': {
            bodyLines: 5,
            blast: { direct: 1, transitive: 9, score: 10 },
            testReachable: true,
          },
        },
      },
    };
    const blastResult = await computeImpact(blastCatalog, ['src/callee.ts']);
    expect(blastResult.impactedFunctions[0]?.reason).toBe('blast');

    const testGapCatalog: GraphCatalog = {
      ...minimalCatalog(),
      features: {
        function: {
          'hash-caller': {
            bodyLines: 5,
            testReachable: false,
          },
        },
      },
    };
    const testGapResult = await computeImpact(testGapCatalog, ['src/callee.ts']);
    expect(testGapResult.impactedFunctions[0]?.reason).toBe('test-gap');
  });

  it('works without features block (forward-compat)', async () => {
    const cat = minimalCatalog();
    const r = await computeImpact(cat, ['src/callee.ts']);
    expect(r.impactedFunctions.length).toBeGreaterThan(0);
  });

  it('marks unmatched changed files as uncertain', async () => {
    const r = await computeImpact(minimalCatalog(), ['src/config.ts']);
    expect(r.trust).toMatchObject({
      coverage: 'unknown',
      fallback: 'targeted',
      fullyVerified: false,
    });
    expect(r.trust.uncertainties).toContainEqual(
      expect.objectContaining({
        code: 'changed-file-unmatched',
        filePath: 'src/config.ts',
      }),
    );
  });

  it('marks deleted and renamed changed files as uncertain', async () => {
    const deleted = await computeImpact(minimalCatalog(), ['src/callee.ts'], {
      changedFileEntries: [{ path: 'src/callee.ts', status: 'deleted' }],
    });
    expect(deleted.trust.uncertainties.map((item) => item.code)).toContain('changed-file-deleted');

    const renamed = await computeImpact(minimalCatalog(), ['src/callee-renamed.ts'], {
      changedFileEntries: [
        {
          path: 'src/callee-renamed.ts',
          previousPath: 'src/callee.ts',
          status: 'renamed',
        },
      ],
    });
    expect(renamed.trust.uncertainties.map((item) => item.code)).toEqual(
      expect.arrayContaining(['changed-file-renamed', 'changed-file-unmatched']),
    );
  });

  it('marks legacy catalogs without freshness metadata as incomplete', async () => {
    const source = minimalCatalog();
    const legacy: GraphCatalog = {
      version: source.version,
      tool: source.tool,
      language: source.language,
      builtAt: source.builtAt,
      functions: source.functions,
    };
    const r = await computeImpact(legacy, ['src/callee.ts']);
    expect(r.trust.uncertainties).toContainEqual(
      expect.objectContaining({ code: 'graph-catalog-incomplete' }),
    );
  });

  it('marks fast or approximate edge catalogs as uncertain', async () => {
    const fast = await computeImpact(
      {
        ...minimalCatalog(),
        resolutionMode: 'fast',
      },
      ['src/callee.ts'],
    );
    expect(fast.trust.uncertainties).toContainEqual(
      expect.objectContaining({ code: 'graph-catalog-approximate' }),
    );

    const source = minimalCatalog();
    const approximateEdge = await computeImpact(
      {
        ...source,
        functions: {
          ...source.functions,
          caller: [
            {
              ...source.functions.caller[0],
              calls: [
                {
                  to: ['hash-callee'],
                  line: 2,
                  column: 4,
                  resolution: 'syntactic',
                  confidence: 'medium',
                  text: 'callee()',
                },
              ],
            },
          ],
        },
      },
      ['src/callee.ts'],
    );
    expect(approximateEdge.trust.uncertainties).toContainEqual(
      expect.objectContaining({ code: 'graph-catalog-approximate' }),
    );
  });

  it('bounds large unmatched-file uncertainty output', async () => {
    const r = await computeImpact(
      minimalCatalog(),
      Array.from({ length: 80 }, (_, index) => `src/config-${String(index)}.ts`),
    );

    expect(r.trust.uncertainties).toHaveLength(50);
    expect(r.trust.uncertainties.at(-1)).toMatchObject({
      code: 'impact-uncertainty-truncated',
    });
  });
});
