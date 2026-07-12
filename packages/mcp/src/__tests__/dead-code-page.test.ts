import { continuationToken } from '@opensip-cli/graph/read';
import { describe, expect, it } from 'vitest';

import { createGeneration } from '../catalog-generation.js';
import {
  deadCodeStableKey,
  MAX_ORPHAN_EVALUATION,
  pageDeadCode as rawPageDeadCode,
} from '../dead-code-page.js';

import type { Catalog, FunctionOccurrence } from '@opensip-cli/graph';
import type { SourceRoleMatcher } from '@opensip-cli/graph/read';

// Task 1.6 threads a required source-role matcher; these tests use no audit
// globs, so a no-op matcher is injected through a thin wrapper.
const noMatcher: SourceRoleMatcher = { matches: () => false };
function pageDeadCode(
  input: Omit<Parameters<typeof rawPageDeadCode>[0], 'matcher'>,
): ReturnType<typeof rawPageDeadCode> {
  return rawPageDeadCode({ ...input, matcher: noMatcher });
}

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

  it('continues after a known cursor, rejects unknown anchors, and groups by package', () => {
    const gen = generation(3);
    const first = pageDeadCode({
      generation: gen,
      config: {},
      filter,
      limit: 1,
      afterKey: undefined,
      groupBy: 'none',
    });
    expect(first.rows).toHaveLength(1);
    const firstKey = deadCodeStableKey(first.rows[0]);
    const after = pageDeadCode({
      generation: gen,
      config: {},
      filter,
      limit: 10,
      afterKey: continuationToken(firstKey),
      groupBy: 'package',
    });
    expect(after.anchorFound).toBe(true);
    expect(after.rows.every((row) => deadCodeStableKey(row) !== firstKey)).toBe(true);
    expect(after.groups?.some((group) => group.key === 'pkg')).toBe(true);

    const missing = pageDeadCode({
      generation: gen,
      config: {},
      filter,
      limit: 10,
      afterKey: continuationToken('no-such-row'),
      groupBy: 'none',
    });
    expect(missing.anchorFound).toBe(false);
    // Without a matched anchor, paging starts from the beginning of the ordered set.
    expect(missing.rows.length).toBeGreaterThan(0);
  });
});
