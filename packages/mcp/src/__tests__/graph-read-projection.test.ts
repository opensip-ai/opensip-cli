import { describe, expect, it } from 'vitest';

import { toDeadCodeDto, toSymbolRef } from '../graph-read-projection.js';

import type { Signal } from '@opensip-cli/core';
import type { Indexes } from '@opensip-cli/graph/read';

function occurrence() {
  return {
    bodyHash: 'h',
    simpleName: 'fn',
    qualifiedName: 'fn',
    filePath: 'src/a.ts',
    line: 1,
    column: 0,
    endLine: 2,
    kind: 'function-declaration' as const,
    params: [] as const,
    returnType: null,
    enclosingClass: null,
    decorators: [] as const,
    visibility: 'exported' as const,
    inTestFile: false,
    definedInGenerated: false,
    calls: [] as const,
  };
}

describe('graph-read-projection', () => {
  it('projects dead-code signals only when span and occurrence resolve', () => {
    const indexes = {
      byOccId: new Map([['src/a.ts:1:0', occurrence()]]),
    } as unknown as Indexes;

    expect(toDeadCodeDto({ message: 'x' } as Signal, indexes)).toBeUndefined();
    expect(
      toDeadCodeDto({ message: 'x', code: { file: 'src/a.ts', line: 1 } } as Signal, indexes),
    ).toBeUndefined();
    expect(
      toDeadCodeDto(
        {
          message: 'orphan',
          // 1-based Signal column for a missing file
          code: { file: 'src/missing.ts', line: 1, column: 1 },
        } as Signal,
        indexes,
      ),
    ).toBeUndefined();

    const dto = toDeadCodeDto(
      {
        message: 'orphan',
        suggestion: 'delete it',
        // 1-based Signal column 1 ↔ occurrence column 0 (ADR-0179)
        code: { file: 'src/a.ts', line: 1, column: 1 },
      } as Signal,
      indexes,
    );
    expect(dto).toMatchObject({
      message: 'orphan',
      suggestion: 'delete it',
      ruleId: 'graph:orphan-subtree',
      symbol: { symbolId: 'src/a.ts:1:0' },
    });

    expect(toSymbolRef(occurrence())?.symbolId).toBe('src/a.ts:1:0');
  });
});
