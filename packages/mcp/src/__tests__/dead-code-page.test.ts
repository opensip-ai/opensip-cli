import { continuationToken } from '@opensip-cli/graph/read';
import { describe, expect, it } from 'vitest';

import { createGeneration } from '../catalog-generation.js';
import {
  deadCodeStableKey,
  MAX_ORPHAN_EVALUATION,
  pageDeadCode as rawPageDeadCode,
} from '../dead-code-page.js';
import { digestNormalizedQuery } from '../graph-query-page.js';

import type { Catalog, FunctionOccurrence } from '@opensip-cli/graph';
import type { SourceRoleMatcher } from '@opensip-cli/graph/read';

const noMatcher: SourceRoleMatcher = { matches: () => false };
const PROJECT = 'b'.repeat(24);
const GEN_DIGEST = digestNormalizedQuery({ op: 'deadCode', test: true });

function pageDeadCode(
  input: Omit<
    Parameters<typeof rawPageDeadCode>[0],
    'matcher' | 'projectKey' | 'queryDigest' | 'detail'
  > & { detail?: 'summary' | 'groups' | 'nodes' },
): ReturnType<typeof rawPageDeadCode> {
  return rawPageDeadCode({
    ...input,
    detail: input.detail ?? 'nodes',
    matcher: noMatcher,
    projectKey: PROJECT,
    queryDigest: GEN_DIGEST,
  });
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
  it('keeps ordinary continuation separate from incomplete coverage (nodes mode)', () => {
    const page = pageDeadCode({
      generation: generation(2),
      config: {},
      filter,
      limit: 1,
      afterKey: undefined,
      groupBy: 'none',
      detail: 'nodes',
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.data.detail).toBe('nodes');
    expect(page.value.data.rows).toHaveLength(1);
    expect(page.value.hasMore).toBe(true);
    expect(page.value.coverage.complete).toBe(true);
    expect(page.value.coverage.inventory.requested).toBe(true);
    expect(page.value.data.rows[0]).toMatchObject({
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
      detail: 'nodes',
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.data.rows).toHaveLength(1);
    expect(page.value.hasMore).toBe(true);
    expect(page.value.coverage.inventory.reasons).toContain('orphan-evaluation-cap');
    expect(page.value.coverage.truncated).toBe(true);
  });

  it('summary mode returns counts without concrete rows', () => {
    const page = pageDeadCode({
      generation: generation(5),
      config: {},
      filter,
      limit: 10,
      afterKey: undefined,
      groupBy: 'none',
      detail: 'summary',
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.data).toMatchObject({
      detail: 'summary',
      rows: [],
      totalOrphans: 5,
    });
    expect(page.value.groups).toBeUndefined();
    expect(page.value.coverage.grouping.requested).toBe(false);
  });

  it('filters before the cap and groups exclusively when detail=groups', () => {
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
      detail: 'groups' as const,
    };
    const forward = pageDeadCode({
      ...query,
      generation: generationFrom([...nonMatching, lateMatch]),
    });
    const reverse = pageDeadCode({
      ...query,
      generation: generationFrom([lateMatch, ...nonMatching]),
    });
    expect(forward.ok && reverse.ok).toBe(true);
    if (!forward.ok || !reverse.ok) return;
    expect(forward.value.data.rows).toEqual([]);
    expect(forward.value.groups).toEqual([{ key: 'keep/late.ts', count: 1 }]);
    expect(reverse.value.groups).toEqual(forward.value.groups);
    expect(forward.value.coverage.grouping.requested).toBe(true);
  });

  it('continues after a known cursor and rejects mixed detail/group modes', () => {
    const gen = generation(3);
    const first = pageDeadCode({
      generation: gen,
      config: {},
      filter,
      limit: 1,
      afterKey: undefined,
      groupBy: 'none',
      detail: 'nodes',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.data.rows).toHaveLength(1);
    const firstKey = deadCodeStableKey(first.value.data.rows[0]!);
    const after = pageDeadCode({
      generation: gen,
      config: {},
      filter,
      limit: 1,
      afterKey: continuationToken(firstKey),
      groupBy: 'none',
      detail: 'nodes',
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.data.rows).toHaveLength(1);
    expect(after.value.data.rows[0]?.symbol.symbolId).not.toBe(
      first.value.data.rows[0]?.symbol.symbolId,
    );

    const invalid = pageDeadCode({
      generation: gen,
      config: {},
      filter,
      limit: 1,
      afterKey: undefined,
      groupBy: 'package',
      detail: 'nodes',
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('invalid-query');
  });
});
