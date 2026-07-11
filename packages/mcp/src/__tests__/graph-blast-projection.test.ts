import { describe, expect, it } from 'vitest';

import { createGeneration } from '../catalog-generation.js';
import { projectBlastMembers } from '../graph-blast-projection.js';

import type { Catalog, FunctionOccurrence } from '@opensip-cli/graph';

function member(filePath: string, packageName: string): FunctionOccurrence {
  return {
    bodyHash: 'same-body',
    simpleName: 'same',
    qualifiedName: `${packageName}.same`,
    filePath,
    line: 1,
    column: 0,
    endLine: 2,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    package: packageName,
  };
}

function generation() {
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-10T00:00:00.000Z',
    cacheKey: 'cache',
    functions: {
      same: [member('packages/a/a.ts', 'a'), member('packages/b/b.ts', 'b')],
    },
  };
  return createGeneration(catalog, 'initial-load');
}

describe('projectBlastMembers', () => {
  it('pages twin membership without changing the canonical score identity', () => {
    const current = generation();
    const first = projectBlastMembers({
      generation: current,
      bodyHash: 'same-body',
      symbolId: 'packages/a/a.ts:1:0',
      filter: { sourceScope: 'all', generated: 'include' },
      options: { limit: 1 },
      projectKey: 'b'.repeat(24),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.members).toHaveLength(1);
    expect(first.value.totalMembership).toBe(2);
    expect(first.value.twinCount).toBe(2);
    expect(first.value.requested?.symbolId).toBe('packages/a/a.ts:1:0');
    expect(first.value.options.page.nextCursor).toBeDefined();
  });

  it('projects the exact requested twin even when it is on a later member page', () => {
    const result = projectBlastMembers({
      generation: generation(),
      bodyHash: 'same-body',
      symbolId: 'packages/b/b.ts:1:0',
      filter: { sourceScope: 'all', generated: 'include' },
      options: { limit: 1 },
      projectKey: 'b'.repeat(24),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.members.map((symbol) => symbol.symbolId)).toEqual(['packages/a/a.ts:1:0']);
    expect(result.value.requested?.symbolId).toBe('packages/b/b.ts:1:0');
  });

  it('handles unknown body hashes, wrong-body requests, package grouping, and bad cursors', () => {
    const current = generation();
    const unknown = projectBlastMembers({
      generation: current,
      bodyHash: 'missing-body',
      symbolId: 'packages/a/a.ts:1:0',
      filter: { sourceScope: 'all', generated: 'include' },
      options: { limit: 10, groupBy: 'package' },
      projectKey: 'b'.repeat(24),
    });
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    expect(unknown.value.members).toEqual([]);
    expect(unknown.value.requested).toBeUndefined();
    expect(unknown.value.twinCount).toBe(0);

    const wrongBody = projectBlastMembers({
      generation: current,
      bodyHash: 'same-body',
      symbolId: 'packages/other/o.ts:1:0',
      filter: { sourceScope: 'all', generated: 'include' },
      options: { groupBy: 'file' },
      projectKey: 'b'.repeat(24),
    });
    expect(wrongBody.ok).toBe(true);
    if (!wrongBody.ok) return;
    expect(wrongBody.value.requested).toBeUndefined();
    expect(wrongBody.value.options.groups?.length).toBeGreaterThan(0);

    const badCursor = projectBlastMembers({
      generation: current,
      bodyHash: 'same-body',
      symbolId: 'packages/a/a.ts:1:0',
      filter: { sourceScope: 'all', generated: 'include' },
      options: { cursor: 'not-a-valid-cursor' },
      projectKey: 'b'.repeat(24),
    });
    expect(badCursor.ok).toBe(false);
  });

  it('labels when a source filter cannot scope the canonical body-twin score', () => {
    const result = projectBlastMembers({
      generation: generation(),
      bodyHash: 'same-body',
      symbolId: 'packages/a/a.ts:1:0',
      filter: { packages: ['a'], sourceScope: 'all', generated: 'include' },
      options: undefined,
      projectKey: 'b'.repeat(24),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.members.map((symbol) => symbol.package)).toEqual(['a']);
    expect(result.value.filteringLimitations).toEqual(['canonical-score-includes-filtered-twins']);
    expect(result.value.options.coverage.complete).toBe(false);
  });

  it('keeps filtered requested identity explicit without substituting another twin', () => {
    const result = projectBlastMembers({
      generation: generation(),
      bodyHash: 'same-body',
      symbolId: 'packages/b/b.ts:1:0',
      filter: { packages: ['a'], sourceScope: 'all', generated: 'include' },
      options: undefined,
      projectKey: 'b'.repeat(24),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requested?.symbolId).toBe('packages/b/b.ts:1:0');
    expect(result.value.members.map((symbol) => symbol.symbolId)).toEqual(['packages/a/a.ts:1:0']);
    expect(result.value.filteringLimitations).toContain('requested-symbol-excluded-by-filter');
  });

  it('reports malformed member omission as partial but not truncated', () => {
    const current = generation();
    const malformed = current.catalog.functions.same?.[0];
    if (malformed === undefined) throw new Error('fixture member missing');
    const catalog: Catalog = {
      ...current.catalog,
      functions: {
        same: [
          { ...malformed, filePath: 'bad\u0085path.ts' },
          ...(current.catalog.functions.same ?? []),
        ],
      },
    };
    const result = projectBlastMembers({
      generation: createGeneration(catalog, 'initial-load'),
      bodyHash: 'same-body',
      symbolId: 'packages/a/a.ts:1:0',
      filter: { sourceScope: 'all', generated: 'include' },
      options: undefined,
      projectKey: 'b'.repeat(24),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.options.coverage).toMatchObject({
      complete: false,
      truncated: false,
    });
    expect(result.value.options.coverage.reasons).toContain('malformed-symbol-omitted');
  });

  it('hard-caps projected membership while preserving the exact requested identity', () => {
    const members = Array.from({ length: 20_001 }, (_, index) =>
      member(`packages/many/member-${String(index).padStart(5, '0')}.ts`, 'many'),
    );
    const requestedId = 'packages/many/member-20000.ts:1:0';
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: '2026-07-10T00:00:00.000Z',
      cacheKey: 'cache',
      functions: { same: members },
    };

    const result = projectBlastMembers({
      generation: createGeneration(catalog, 'initial-load'),
      bodyHash: 'same-body',
      symbolId: requestedId,
      filter: { sourceScope: 'all', generated: 'include' },
      options: { limit: 500 },
      projectKey: 'b'.repeat(24),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.members).toHaveLength(500);
    expect(result.value.totalMembership).toBe(20_000);
    expect(result.value.twinCount).toBe(20_001);
    expect(result.value.requested?.symbolId).toBe(requestedId);
    expect(result.value.options.page.nextCursor).toBeDefined();
    expect(result.value.options.coverage).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(result.value.options.coverage.reasons).toContain('blast-membership-cap');
  });
});
