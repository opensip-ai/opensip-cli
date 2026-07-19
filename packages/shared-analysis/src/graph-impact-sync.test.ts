import { describe, expect, it } from 'vitest';

import { computeImpact } from './graph-impact-compute.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-cli/contracts';

function occurrence(
  overrides: Partial<GraphFunctionOccurrence> &
    Pick<GraphFunctionOccurrence, 'bodyHash' | 'qualifiedName' | 'filePath'>,
): GraphFunctionOccurrence {
  return {
    simpleName: overrides.qualifiedName,
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
    ...overrides,
  };
}

function catalog(
  functions: Record<string, GraphFunctionOccurrence[]>,
  extra: Partial<GraphCatalog> = {},
): GraphCatalog {
  return {
    version: '2.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-01-01T00:00:00.000Z',
    cacheKey: 'test-cache',
    filesFingerprint: 'test-fingerprint',
    functions,
    ...extra,
  };
}

describe('computeImpact synchronous engine edge cases', () => {
  it('marks non-array calls and malformed edge payloads as approximate', () => {
    const result = computeImpact(
      catalog({
        brokenCalls: [
          occurrence({
            bodyHash: 'hash-broken',
            qualifiedName: 'brokenCalls',
            filePath: 'src/broken.ts',
            // Force the non-array branch in reverse-edge indexing.
            calls: 'not-an-array' as unknown as GraphFunctionOccurrence['calls'],
          }),
        ],
        badEdge: [
          occurrence({
            bodyHash: 'hash-bad-edge',
            qualifiedName: 'badEdge',
            filePath: 'src/bad-edge.ts',
            calls: [
              null as unknown as GraphFunctionOccurrence['calls'][number],
              {
                to: 'not-array' as unknown as string[],
                line: 1,
                column: 1,
                resolution: 'static',
                confidence: 'high',
                text: 'x()',
              },
              {
                to: [42 as unknown as string, 'hash-target'],
                line: 2,
                column: 1,
                resolution: 'static',
                confidence: 'high',
                text: 'y()',
              },
            ],
          }),
        ],
        target: [
          occurrence({
            bodyHash: 'hash-target',
            qualifiedName: 'target',
            filePath: 'src/target.ts',
          }),
        ],
        caller: [
          occurrence({
            bodyHash: 'hash-caller',
            qualifiedName: 'caller',
            filePath: 'src/caller.ts',
            calls: [
              {
                to: ['hash-target'],
                line: 1,
                column: 1,
                resolution: 'syntactic',
                confidence: 'medium',
                text: 'target()',
              },
            ],
          }),
        ],
      }),
      ['src/target.ts'],
    );

    expect(result.changedFunctions.map((fn) => fn.qualifiedName)).toEqual(['target']);
    expect(result.impactedFunctions.map((fn) => fn.qualifiedName).sort()).toEqual([
      'badEdge',
      'caller',
    ]);
    expect(result.trust.uncertainties).toContainEqual(
      expect.objectContaining({ code: 'graph-catalog-approximate' }),
    );
  });

  it('skips non-own function keys and undefined occurrence bags', () => {
    const functions = Object.create(null) as Record<string, GraphFunctionOccurrence[] | undefined>;
    functions.real = [
      occurrence({
        bodyHash: 'hash-real',
        qualifiedName: 'real',
        filePath: 'src/real.ts',
      }),
    ];
    Object.defineProperty(functions, 'ghost', {
      enumerable: true,
      value: undefined,
    });
    // Inherited enumerable name must be ignored via Object.hasOwn.
    const proto = { inherited: functions.real };
    Object.setPrototypeOf(functions, proto);

    // `functions` intentionally carries an undefined occurrence bag (the `ghost`
    // key above) to exercise the skip path; `catalog` types functions as
    // non-undefined, so assert the narrower type at the boundary.
    const result = computeImpact(catalog(functions as Record<string, GraphFunctionOccurrence[]>), [
      'src/real.ts',
    ]);
    expect(result.changedFunctions).toHaveLength(1);
    expect(result.changedFunctions[0]?.qualifiedName).toBe('real');
  });

  it('truncates changed rows and reverse traversal under a tight top cap', () => {
    const functions: Record<string, GraphFunctionOccurrence[]> = {};
    for (let index = 0; index < 8; index++) {
      functions[`changed${String(index)}`] = [
        occurrence({
          bodyHash: `hash-changed-${String(index)}`,
          qualifiedName: `changed${String(index)}`,
          filePath: 'src/changed.ts',
        }),
      ];
    }
    // Many distinct callers of the first changed body so reverse BFS can truncate.
    for (let index = 0; index < 12; index++) {
      functions[`caller${String(index)}`] = [
        occurrence({
          bodyHash: `hash-caller-${String(index)}`,
          qualifiedName: `caller${String(index)}`,
          filePath: `src/caller-${String(index)}.ts`,
          package: index % 2 === 0 ? 'alpha' : 'beta',
          calls: [
            {
              to: ['hash-changed-0'],
              line: 1,
              column: 1,
              resolution: 'static',
              confidence: 'high',
              text: 'changed0()',
            },
          ],
        }),
      ];
    }

    const truncatedChanged = computeImpact(catalog(functions), ['src/changed.ts'], { top: 3 });
    expect(truncatedChanged.changedFunctions).toHaveLength(3);
    expect(truncatedChanged.truncated).toBe(true);
    expect(truncatedChanged.trust.uncertainties).toContainEqual(
      expect.objectContaining({ code: 'impact-truncated' }),
    );

    // Leave room for all changed rows, then bound reverse callers.
    const truncatedImpacted = computeImpact(catalog(functions), ['src/changed.ts'], {
      top: 10,
      maxDepth: 1,
    });
    expect(truncatedImpacted.changedFunctions.length).toBeGreaterThan(0);
    expect(
      truncatedImpacted.changedFunctions.length + truncatedImpacted.impactedFunctions.length,
    ).toBeLessThanOrEqual(10);
    expect(truncatedImpacted.truncated).toBe(true);
  });

  it('stops reverse BFS at maxDepth and skips already-visited callers', () => {
    const result = computeImpact(
      catalog({
        leaf: [
          occurrence({
            bodyHash: 'hash-leaf',
            qualifiedName: 'leaf',
            filePath: 'src/leaf.ts',
          }),
        ],
        mid: [
          occurrence({
            bodyHash: 'hash-mid',
            qualifiedName: 'mid',
            filePath: 'src/mid.ts',
            calls: [
              {
                to: ['hash-leaf'],
                line: 1,
                column: 1,
                resolution: 'static',
                confidence: 'high',
                text: 'leaf()',
              },
              // Duplicate edge — already-visited skip once mid is enqueued.
              {
                to: ['hash-leaf'],
                line: 2,
                column: 1,
                resolution: 'static',
                confidence: 'high',
                text: 'leaf()',
              },
            ],
          }),
        ],
        top: [
          occurrence({
            bodyHash: 'hash-top',
            qualifiedName: 'top',
            filePath: 'src/top.ts',
            calls: [
              {
                to: ['hash-mid'],
                line: 1,
                column: 1,
                resolution: 'static',
                confidence: 'high',
                text: 'mid()',
              },
            ],
          }),
        ],
        // A changed file that also calls leaf — changed ordinals are skipped as callers.
        alsoChanged: [
          occurrence({
            bodyHash: 'hash-also',
            qualifiedName: 'alsoChanged',
            filePath: 'src/also.ts',
            calls: [
              {
                to: ['hash-leaf'],
                line: 1,
                column: 1,
                resolution: 'static',
                confidence: 'high',
                text: 'leaf()',
              },
            ],
          }),
        ],
      }),
      ['src/leaf.ts', 'src/also.ts'],
      { maxDepth: 1 },
    );

    expect(result.impactedFunctions.map((fn) => fn.qualifiedName)).toEqual(['mid']);
    expect(result.changedFunctions.map((fn) => fn.qualifiedName).sort()).toEqual([
      'alsoChanged',
      'leaf',
    ]);
  });

  it('omits malformed rows and ranks equal package counts by name', () => {
    const longName = 'n'.repeat(1025);
    const result = computeImpact(
      catalog({
        goodA: [
          occurrence({
            bodyHash: 'hash-a',
            qualifiedName: 'goodA',
            filePath: 'src/a.ts',
            package: 'shared',
          }),
        ],
        goodB: [
          occurrence({
            bodyHash: 'hash-b',
            qualifiedName: 'goodB',
            filePath: 'src/b.ts',
            package: 'shared',
          }),
        ],
        zeta: [
          occurrence({
            bodyHash: 'hash-zeta',
            qualifiedName: 'zeta',
            filePath: 'src/zeta.ts',
            package: 'zeta',
          }),
        ],
        malformed: [
          occurrence({
            bodyHash: 'hash-bad',
            qualifiedName: longName,
            filePath: 'src/malformed.ts',
            package: 'shared',
          }),
        ],
        caller: [
          occurrence({
            bodyHash: 'hash-caller',
            qualifiedName: 'caller',
            filePath: 'src/caller.ts',
            package: 'alpha',
            calls: [
              {
                to: ['hash-a', 'hash-bad'],
                line: 1,
                column: 1,
                resolution: 'static',
                confidence: 'high',
                text: 'goodA(); malformed()',
              },
            ],
          }),
        ],
      }),
      ['src/a.ts', 'src/b.ts', 'src/zeta.ts', 'src/malformed.ts'],
    );

    expect(result.changedFunctions.map((fn) => fn.qualifiedName).sort()).toEqual([
      'goodA',
      'goodB',
      'zeta',
    ]);
    expect(result.trust.uncertainties).toContainEqual(
      expect.objectContaining({ code: 'impact-malformed-row-omitted' }),
    );
    // shared has two functions; alpha (caller) and zeta each have one — tie-break by name.
    expect(result.impactedPackages).toEqual([
      { name: 'shared', functionCount: 2 },
      { name: 'alpha', functionCount: 1 },
      { name: 'zeta', functionCount: 1 },
    ]);
  });

  it('ignores non-string occurrence file paths when collecting changed files', () => {
    const result = computeImpact(
      catalog({
        noPath: [
          occurrence({
            bodyHash: 'hash-no-path',
            qualifiedName: 'noPath',
            filePath: 42 as unknown as string,
          }),
        ],
        ok: [
          occurrence({
            bodyHash: 'hash-ok',
            qualifiedName: 'ok',
            filePath: 'src\\ok.ts',
          }),
        ],
      }),
      ['src/ok.ts'],
    );
    expect(result.changedFunctions.map((fn) => fn.qualifiedName)).toEqual(['ok']);
  });
});
