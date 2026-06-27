import { describe, expect, it } from 'vitest';

import { computeImpact, type GraphCatalog } from '../index.js';

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

describe('computeImpact', () => {
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

  it('works without features block (forward-compat)', () => {
    const cat = minimalCatalog();
    const r = computeImpact(cat, ['src/callee.ts']);
    expect(r.impactedFunctions.length).toBeGreaterThan(0);
  });
});
