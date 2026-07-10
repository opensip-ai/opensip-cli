import { describe, expect, it } from 'vitest';

import { createGeneration } from '../catalog-generation.js';

import type { Catalog, FunctionOccurrence } from '@opensip-cli/graph';

function occurrence(
  bodyHash: string,
  simpleName: string,
  calls: FunctionOccurrence['calls'] = [],
): FunctionOccurrence {
  return {
    bodyHash,
    simpleName,
    qualifiedName: simpleName,
    filePath: `src/${simpleName}.ts`,
    line: 1,
    column: 0,
    endLine: 3,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile: false,
    definedInGenerated: false,
    calls,
  };
}

describe('createGeneration', () => {
  it('pins the catalog and derives canonical caller/callee indexes once', () => {
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: '2026-07-09T00:00:00.000Z',
      cacheKey: 'test',
      filesFingerprint: '0',
      functions: {
        caller: [
          occurrence('caller-hash', 'caller', [
            {
              to: ['target-hash'],
              line: 2,
              column: 0,
              resolution: 'static',
              confidence: 'high',
              text: 'target()',
            },
          ]),
        ],
        target: [occurrence('target-hash', 'target')],
      },
    };

    const generation = createGeneration(catalog);
    expect(generation.catalog).toBe(catalog);
    expect(generation.builtAt).toBe(catalog.builtAt);
    expect(generation.indexes.callees.get('caller-hash')).toEqual(['target-hash']);
    expect(generation.indexes.callers.get('target-hash')).toEqual(['caller-hash']);
  });
});
