import { describe, expect, it } from 'vitest';

import { createGeneration } from '../catalog-generation.js';
import { MAX_ORPHAN_EVALUATION, pageDeadCode } from '../dead-code-page.js';

import type { Catalog, FunctionOccurrence } from '@opensip-cli/graph';

function occurrence(index: number): FunctionOccurrence {
  return {
    bodyHash: `hash-${String(index)}`,
    simpleName: `unused${String(index)}`,
    qualifiedName: `pkg.unused${String(index)}`,
    filePath: `src/unused-${String(index).padStart(5, '0')}.ts`,
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
    calls: [],
    package: 'pkg',
  };
}

function generation(size: number) {
  return generationFrom(Array.from({ length: size }, (_, index) => occurrence(index)));
}

function generationFrom(occurrences: readonly FunctionOccurrence[]) {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const row of occurrences) {
    functions[row.simpleName] = [row];
  }
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-10T00:00:00.000Z',
    cacheKey: 'dead-code-page',
    filesFingerprint: '0',
    functions,
  };
  return createGeneration(catalog, 'initial-load');
}

const filter = { sourceScope: 'all' as const, generated: 'include' as const };

describe('pageDeadCode', () => {
  it('keeps ordinary continuation separate from incomplete coverage', () => {
    const page = pageDeadCode({
      generation: generation(2),
      config: {},
      filter,
      limit: 1,
      afterKey: undefined,
      groupBy: 'none',
    });
    expect(page.rows).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.coverage).toEqual({ complete: true, truncated: false, reasons: [] });
    expect(page.rows[0]).toMatchObject({
      ruleId: 'graph:orphan-subtree',
      reason: 'unreachable-from-inferred-entry-point',
    });
  });

  it('marks only the hard orphan-evaluation ceiling as truncated', () => {
    const page = pageDeadCode({
      generation: generation(MAX_ORPHAN_EVALUATION + 1),
      config: {},
      filter,
      limit: 1,
      afterKey: undefined,
      groupBy: 'none',
    });
    expect(page.rows).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.coverage).toEqual({
      complete: false,
      truncated: true,
      reasons: ['orphan-evaluation-cap'],
    });
  });

  it('filters before the cap and is independent of orphan emission order', () => {
    const nonMatching = Array.from({ length: MAX_ORPHAN_EVALUATION }, (_, index) =>
      occurrence(index),
    );
    const lateMatch: FunctionOccurrence = {
      ...occurrence(MAX_ORPHAN_EVALUATION),
      simpleName: 'lateMatch',
      qualifiedName: 'pkg.lateMatch',
      filePath: 'keep/late.ts',
    };
    const query = {
      config: {},
      filter: { ...filter, filePrefix: 'keep' },
      limit: 10,
      afterKey: undefined,
      groupBy: 'file' as const,
    };
    const forward = pageDeadCode({
      ...query,
      generation: generationFrom([...nonMatching, lateMatch]),
    });
    const reverse = pageDeadCode({
      ...query,
      generation: generationFrom([lateMatch, ...nonMatching]),
    });
    expect(forward.rows.map((row) => row.symbol.symbolId)).toEqual(['keep/late.ts:1:0']);
    expect(reverse.rows).toEqual(forward.rows);
    expect(forward.groups).toEqual([{ key: 'keep/late.ts', count: 1 }]);
    expect(forward.coverage).toEqual({ complete: true, truncated: false, reasons: [] });
  });
});
