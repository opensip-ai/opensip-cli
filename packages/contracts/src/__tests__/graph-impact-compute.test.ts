import { describe, expect, it } from 'vitest';

import { computeImpact, type GraphCatalog, type GraphFunctionOccurrence } from '../index.js';

function minimalCatalog(): GraphCatalog {
  return {
    version: '2.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-01-01T00:00:00.000Z',
    functions: {
      caller: [
        {
          bodyHash: 'caller',
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
              to: ['callee'],
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
          bodyHash: 'callee',
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
        bodyHash: `f${i}`,
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
                  to: [`f${i - 1}`],
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
    functions,
  };
}

describe('computeImpact', () => {
  it('stops the reverse-BFS at maxDepth', () => {
    // Chain f0..f6; change f0. With maxDepth 2, only f1 (depth 1) and f2
    // (depth 2) are impacted — f3..f6 lie beyond the bound.
    const r = computeImpact(chainCatalog(7), ['src/f0.ts'], { maxDepth: 2 });
    const names = r.impactedFunctions.map((f) => f.qualifiedName).sort();
    expect(names).toEqual(['f1', 'f2']);
  });

  it('walks the full chain when maxDepth is generous', () => {
    const r = computeImpact(chainCatalog(7), ['src/f0.ts'], { maxDepth: 10 });
    const names = r.impactedFunctions.map((f) => f.qualifiedName).sort();
    expect(names).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
  });

  it('finds changed functions and reverse callers', () => {
    const r = computeImpact(minimalCatalog(), ['src/callee.ts']);
    expect(r.changedFunctions).toHaveLength(1);
    expect(r.changedFunctions[0]?.qualifiedName).toBe('callee');
    expect(r.impactedFunctions.some((f) => f.qualifiedName === 'caller')).toBe(true);
  });

  it('honors top cap and sets truncated', () => {
    const r = computeImpact(minimalCatalog(), ['src/callee.ts'], { top: 1 });
    expect(r.truncated).toBe(true);
  });

  it('does not truncate when the top cap covers the full result', () => {
    const r = computeImpact(minimalCatalog(), ['src/callee.ts'], { top: 10 });
    expect(r.truncated).toBe(false);
    expect(r.impactedFunctions).toHaveLength(1);
  });

  it('treats negative top caps as uncapped for forward-compatible callers', () => {
    const r = computeImpact(minimalCatalog(), ['src/callee.ts'], { top: -1 });
    expect(r.truncated).toBe(false);
    expect(r.impactedFunctions).toHaveLength(1);
  });

  it('normalizes changed file paths before matching catalog occurrences', () => {
    const r = computeImpact(minimalCatalog(), ['src\\callee.ts']);
    expect(r.changedFunctions.map((f) => f.qualifiedName)).toEqual(['callee']);
  });

  it('classifies impacted callers with blast and test-gap reasons', () => {
    const blastCatalog: GraphCatalog = {
      ...minimalCatalog(),
      features: {
        function: {
          caller: {
            bodyLines: 5,
            blast: { direct: 1, transitive: 9, score: 10 },
            testReachable: true,
          },
        },
      },
    };
    expect(computeImpact(blastCatalog, ['src/callee.ts']).impactedFunctions[0]?.reason).toBe(
      'blast',
    );

    const testGapCatalog: GraphCatalog = {
      ...minimalCatalog(),
      features: {
        function: {
          caller: {
            bodyLines: 5,
            testReachable: false,
          },
        },
      },
    };
    expect(computeImpact(testGapCatalog, ['src/callee.ts']).impactedFunctions[0]?.reason).toBe(
      'test-gap',
    );
  });

  it('works without features block (forward-compat)', () => {
    const cat = minimalCatalog();
    const r = computeImpact(cat, ['src/callee.ts']);
    expect(r.impactedFunctions.length).toBeGreaterThan(0);
  });
});
