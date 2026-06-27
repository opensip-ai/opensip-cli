import { describe, expect, it } from 'vitest';

import { buildLookupResult } from '../lookup-result.js';

import type { FunctionOccurrence } from '../../types.js';

function makeOccurrence(overrides: Partial<FunctionOccurrence> = {}): FunctionOccurrence {
  return {
    bodyHash: 'hash-1',
    bodySize: 12,
    simpleName: 'save',
    qualifiedName: 'pkg/save',
    filePath: 'src/save.ts',
    package: '@scope/pkg',
    line: 4,
    column: 2,
    endLine: 8,
    kind: 'function-declaration',
    params: [{ name: 'x', optional: false, rest: false }],
    returnType: 'void',
    enclosingClass: null,
    decorators: ['memo'],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [
      {
        to: ['hash-2'],
        line: 6,
        column: 4,
        resolution: 'static',
        confidence: 'high',
        text: 'other()',
      },
    ],
    dependencies: [
      {
        to: ['hash-dep'],
        line: 1,
        column: 0,
        specifier: '@scope/dep',
      },
    ],
    ...overrides,
  };
}

describe('buildLookupResult', () => {
  it('maps occurrences into the graph-lookup wire shape', () => {
    const result = buildLookupResult('save', [makeOccurrence()], 'exact');

    expect(result).toEqual({
      type: 'graph-lookup',
      name: 'save',
      resolutionMode: 'exact',
      matches: [
        {
          bodyHash: 'hash-1',
          bodySize: 12,
          simpleName: 'save',
          qualifiedName: 'pkg/save',
          filePath: 'src/save.ts',
          package: '@scope/pkg',
          line: 4,
          column: 2,
          endLine: 8,
          kind: 'function-declaration',
          params: [{ name: 'x', optional: false, rest: false }],
          returnType: 'void',
          enclosingClass: null,
          decorators: ['memo'],
          visibility: 'exported',
          inTestFile: false,
          definedInGenerated: false,
          calls: [
            {
              to: ['hash-2'],
              line: 6,
              column: 4,
              resolution: 'static',
              confidence: 'high',
              text: 'other()',
            },
          ],
          dependencies: [
            {
              to: ['hash-dep'],
              line: 1,
              column: 0,
              specifier: '@scope/dep',
            },
          ],
        },
      ],
    });
  });

  it('omits optional match fields when the occurrence does not carry them', () => {
    const result = buildLookupResult(
      'init',
      [
        makeOccurrence({
          bodySize: undefined,
          package: undefined,
          calls: [],
          dependencies: undefined,
        }),
      ],
      'fast',
    );

    expect(result.matches[0]).toEqual({
      bodyHash: 'hash-1',
      simpleName: 'save',
      qualifiedName: 'pkg/save',
      filePath: 'src/save.ts',
      line: 4,
      column: 2,
      endLine: 8,
      kind: 'function-declaration',
      params: [{ name: 'x', optional: false, rest: false }],
      returnType: 'void',
      enclosingClass: null,
      decorators: ['memo'],
      visibility: 'exported',
      inTestFile: false,
      definedInGenerated: false,
    });
  });
});
