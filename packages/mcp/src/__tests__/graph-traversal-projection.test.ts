import { describe, expect, it } from 'vitest';

import { createGeneration } from '../catalog-generation.js';
import { projectTraversal as rawProjectTraversal } from '../graph-traversal-projection.js';

import type { Catalog, FunctionOccurrence } from '@opensip-cli/graph';
import type { SourceRoleMatcher } from '@opensip-cli/graph/read';

// Task 1.5: projectTraversal now requires a source-role matcher; these tests use
// no audit globs, so a no-op matcher is threaded through a thin wrapper.
const noMatcher: SourceRoleMatcher = { matches: () => false };
type ProjectTraversalArgs = Parameters<typeof rawProjectTraversal>;
function projectTraversal(
  generation: ProjectTraversalArgs[0],
  query: ProjectTraversalArgs[1],
  filter: ProjectTraversalArgs[2],
  projectKey: ProjectTraversalArgs[3],
): ReturnType<typeof rawProjectTraversal> {
  return rawProjectTraversal(generation, query, filter, projectKey, noMatcher);
}

function occurrence(
  partial: Partial<FunctionOccurrence> &
    Pick<FunctionOccurrence, 'bodyHash' | 'simpleName' | 'filePath' | 'package'>,
): FunctionOccurrence {
  return {
    qualifiedName: `${partial.package}.${partial.simpleName}`,
    line: 1,
    column: 0,
    endLine: 5,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...partial,
  };
}

function fixture(): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-10T00:00:00.000Z',
    cacheKey: 'cache',
    filesFingerprint: '0',
    functions: {
      targetA: [
        occurrence({
          bodyHash: 'target-body',
          simpleName: 'targetA',
          filePath: 'packages/a/target.ts',
          package: 'a',
        }),
      ],
      targetB: [
        occurrence({
          bodyHash: 'target-body',
          simpleName: 'targetB',
          filePath: 'packages/b/target.ts',
          package: 'b',
        }),
      ],
      callerA: [
        occurrence({
          bodyHash: 'caller-a',
          simpleName: 'callerA',
          filePath: 'packages/a/caller.ts',
          package: 'a',
          calls: [
            {
              to: ['target-body'],
              line: 3,
              column: 2,
              resolution: 'semantic',
              confidence: 'medium',
              crossShard: true,
              text: 'targetA()',
            },
          ],
        }),
      ],
      callerB: [
        occurrence({
          bodyHash: 'caller-b',
          simpleName: 'callerB',
          filePath: 'packages/b/caller.ts',
          package: 'b',
          calls: [
            {
              to: ['target-body'],
              line: 4,
              column: 2,
              resolution: 'static',
              confidence: 'high',
              text: 'targetB()',
            },
          ],
        }),
      ],
      testCaller: [
        occurrence({
          bodyHash: 'caller-test',
          simpleName: 'testCaller',
          filePath: 'packages/a/caller.test.ts',
          package: 'a',
          inTestFile: true,
          calls: [
            {
              to: ['target-body'],
              line: 2,
              column: 1,
              resolution: 'static',
              confidence: 'low',
              text: 'targetA()',
            },
          ],
        }),
      ],
    },
  };
}

const FILTER = { sourceScope: 'production', generated: 'exclude' } as const;
const PROJECT_KEY = 'a'.repeat(24);

describe('projectTraversal', () => {
  it('defaults to precise occurrence callers with incoming provenance', () => {
    const generation = createGeneration(fixture(), 'initial-load');
    const result = projectTraversal(
      generation,
      {
        direction: 'callers',
        startSymbolId: 'packages/a/target.ts:1:0',
        depth: 2,
      },
      FILTER,
      PROJECT_KEY,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.nodes.map((row) => row.symbol.symbolId)).toEqual([
      'packages/a/target.ts:1:0',
      'packages/a/caller.ts:1:0',
    ]);
    expect(result.value.data.nodes[1]?.depth).toBe(1);
    expect(result.value.data.nodes[1]?.incomingEvidence).toMatchObject({
      confidence: 'medium',
      crossShard: true,
    });
    expect(result.value.data.nodes.some((row) => row.symbol.inTestFile)).toBe(false);
  });

  it('flattens all filtered twin members and pages them with a generation-bound cursor', () => {
    const generation = createGeneration(fixture(), 'initial-load');
    const first = projectTraversal(
      generation,
      {
        direction: 'callers',
        startSymbolId: 'packages/a/target.ts:1:0',
        identity: 'body-twin-union',
        limit: 1,
      },
      FILTER,
      PROJECT_KEY,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.data.nodes).toHaveLength(1);
    expect(first.value.data.totalMembership).toBe(4);
    expect(first.value.options.page.nextCursor).toBeDefined();

    const second = projectTraversal(
      generation,
      {
        direction: 'callers',
        startSymbolId: 'packages/a/target.ts:1:0',
        identity: 'body-twin-union',
        limit: 1,
        cursor: first.value.options.page.nextCursor,
      },
      FILTER,
      PROJECT_KEY,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.data.nodes[0]?.symbol.symbolId).not.toBe(
      first.value.data.nodes[0]?.symbol.symbolId,
    );
    expect(second.value.data.nodes[0]?.groupTotal).toBe(2);
  });

  it("does not attribute another twin's edge to a non-contributing member", () => {
    const generation = createGeneration(fixture(), 'initial-load');
    const result = projectTraversal(
      generation,
      {
        direction: 'callees',
        startSymbolId: 'packages/a/caller.ts:1:0',
        identity: 'body-twin-union',
      },
      FILTER,
      PROJECT_KEY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const targetA = result.value.data.nodes.find(
      (row) => row.symbol.symbolId === 'packages/a/target.ts:1:0',
    );
    const targetB = result.value.data.nodes.find(
      (row) => row.symbol.symbolId === 'packages/b/target.ts:1:0',
    );
    expect(targetA?.incomingEvidence?.to.symbolId).toBe('packages/a/target.ts:1:0');
    expect(targetB?.incomingEvidence).toBeUndefined();
  });

  it('returns ordered path evidence and the weakest hop confidence', () => {
    const generation = createGeneration(fixture(), 'initial-load');
    const result = projectTraversal(
      generation,
      {
        direction: 'path',
        startSymbolId: 'packages/a/caller.ts:1:0',
        goalSymbolId: 'packages/a/target.ts:1:0',
        limit: 1,
      },
      FILTER,
      PROJECT_KEY,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.found).toBe(true);
    expect(result.value.data.nodes).toHaveLength(1);
    expect(result.value.data.path?.map((symbol) => symbol.symbolId)).toEqual([
      'packages/a/caller.ts:1:0',
      'packages/a/target.ts:1:0',
    ]);
    expect(result.value.data.hops?.[0]?.evidence[0]).toMatchObject({
      resolution: 'semantic',
      confidence: 'medium',
      crossShard: true,
    });
    expect(result.value.data.weakestConfidence).toBe('medium');
  });

  it('returns one representative per body-twin path group rather than every member', () => {
    const result = projectTraversal(
      createGeneration(fixture(), 'initial-load'),
      {
        direction: 'path',
        startSymbolId: 'packages/a/caller.ts:1:0',
        goalSymbolId: 'packages/a/target.ts:1:0',
        identity: 'body-twin-union',
      },
      FILTER,
      PROJECT_KEY,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.path).toHaveLength(2);
    expect(result.value.data.hops).toHaveLength(1);
    expect(result.value.data.path?.[0]?.symbolId).toBe('packages/a/caller.ts:1:0');
    expect(result.value.data.path?.[1]?.symbolId).toBe('packages/a/target.ts:1:0');
  });

  it('returns symbol-not-found instead of a complete no-path for absent endpoints', () => {
    const generation = createGeneration(fixture(), 'initial-load');
    const missingStart = projectTraversal(
      generation,
      { direction: 'callees', startSymbolId: 'packages/a/missing.ts:1:0' },
      FILTER,
      PROJECT_KEY,
    );
    const missingGoal = projectTraversal(
      generation,
      {
        direction: 'path',
        startSymbolId: 'packages/a/caller.ts:1:0',
        goalSymbolId: 'packages/a/missing.ts:1:0',
      },
      FILTER,
      PROJECT_KEY,
    );

    expect(missingStart.ok).toBe(false);
    expect(missingGoal.ok).toBe(false);
    if (!missingStart.ok) expect(missingStart.error.code).toBe('symbol-not-found');
    if (!missingGoal.ok) expect(missingGoal.error.code).toBe('symbol-not-found');
  });

  it('rejects malformed and stale cursors even after the catalog disappears', () => {
    const query = {
      direction: 'callers' as const,
      startSymbolId: 'packages/a/target.ts:1:0',
      limit: 1,
    };
    const first = projectTraversal(
      createGeneration(fixture(), 'initial-load'),
      query,
      FILTER,
      PROJECT_KEY,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const stale = projectTraversal(
      undefined,
      { ...query, cursor: first.value.options.page.nextCursor },
      FILTER,
      PROJECT_KEY,
    );
    const malformed = projectTraversal(
      undefined,
      { ...query, cursor: 'not-a-real-cursor' },
      FILTER,
      PROJECT_KEY,
    );

    expect(stale.ok).toBe(false);
    expect(malformed.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('cursor-stale');
    if (!malformed.ok) expect(malformed.error.code).toBe('cursor-invalid');
  });

  it('computes weakest confidence across evidence beyond the 50-row sample', () => {
    const callers = Array.from({ length: 51 }, (_, index) =>
      occurrence({
        bodyHash: 'caller-twins',
        simpleName: `caller${String(index).padStart(2, '0')}`,
        filePath:
          index === 50
            ? 'packages/a/z-low.ts'
            : `packages/a/a-${String(index).padStart(2, '0')}.ts`,
        package: 'a',
        calls: [
          {
            to: ['goal'],
            line: 2,
            column: 0,
            resolution: 'static',
            confidence: index === 50 ? 'low' : 'high',
            text: 'goal()',
          },
        ],
      }),
    );
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: '2026-07-10T00:00:00.000Z',
      cacheKey: 'many-evidence',
      functions: {
        callers,
        goal: [
          occurrence({
            bodyHash: 'goal',
            simpleName: 'goal',
            filePath: 'packages/a/goal.ts',
            package: 'a',
          }),
        ],
      },
    };
    const result = projectTraversal(
      createGeneration(catalog, 'initial-load'),
      {
        direction: 'path',
        startSymbolId: 'packages/a/a-00.ts:1:0',
        goalSymbolId: 'packages/a/goal.ts:1:0',
        identity: 'body-twin-union',
      },
      FILTER,
      PROJECT_KEY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.hops?.[0]?.evidence).toHaveLength(50);
    expect(result.value.data.hops?.[0]?.weakestConfidence).toBe('low');
    expect(result.value.data.weakestConfidence).toBe('low');
    expect(result.value.options.coverage.reasons).toContain('hop-evidence-cap');
    expect(result.value.options.coverage.inventory.requested).toBe(true);
  });

  it('projects exclusive summary and groups without concrete nodes (P2 Phase 2.6)', () => {
    const generation = createGeneration(fixture(), 'initial-load');
    const summary = projectTraversal(
      generation,
      {
        direction: 'callers',
        startSymbolId: 'packages/a/target.ts:1:0',
        detail: 'summary',
      },
      FILTER,
      PROJECT_KEY,
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.data.nodes).toEqual([]);
    expect(summary.value.data.unresolved).toEqual([]);
    expect(summary.value.data.totalMembership).toBeGreaterThan(0);
    expect(summary.value.options.groups).toBeUndefined();
    expect(summary.value.options.coverage.grouping.requested).toBe(false);

    const groups = projectTraversal(
      generation,
      {
        direction: 'callers',
        startSymbolId: 'packages/a/target.ts:1:0',
        detail: 'groups',
        groupBy: 'package',
        limit: 10,
      },
      FILTER,
      PROJECT_KEY,
    );
    expect(groups.ok).toBe(true);
    if (!groups.ok) return;
    expect(groups.value.data.nodes).toEqual([]);
    expect(groups.value.options.groups?.length).toBeGreaterThan(0);
    expect(groups.value.options.coverage.grouping.requested).toBe(true);

    const mismatch = projectTraversal(
      generation,
      {
        direction: 'callers',
        startSymbolId: 'packages/a/target.ts:1:0',
        detail: 'nodes',
        groupBy: 'package',
      },
      FILTER,
      PROJECT_KEY,
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe('invalid-query');
  });

  it('stops goal-directed collection before later siblings and counts only path membership', () => {
    const start = occurrence({
      bodyHash: 'start',
      simpleName: 'start',
      filePath: 'packages/a/start.ts',
      package: 'a',
      calls: [
        {
          to: ['goal', 'sibling'],
          line: 2,
          column: 0,
          resolution: 'static',
          confidence: 'high',
          text: 'branch()',
        },
      ],
    });
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: '2026-07-10T00:00:00.000Z',
      cacheKey: 'branch',
      functions: {
        start: [start],
        goal: [
          occurrence({
            bodyHash: 'goal',
            simpleName: 'goal',
            filePath: 'packages/a/a-goal.ts',
            package: 'a',
          }),
        ],
        sibling: [
          occurrence({
            bodyHash: 'sibling',
            simpleName: 'sibling',
            filePath: 'packages/a/z-sibling.ts',
            package: 'a',
          }),
        ],
      },
    };
    const result = projectTraversal(
      createGeneration(catalog, 'initial-load'),
      {
        direction: 'path',
        startSymbolId: 'packages/a/start.ts:1:0',
        goalSymbolId: 'packages/a/a-goal.ts:1:0',
        identity: 'occurrence',
      },
      FILTER,
      PROJECT_KEY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.nodes.map((row) => row.symbol.simpleName)).toEqual(['start', 'goal']);
    expect(result.value.data.totalMembership).toBe(2);
    expect(result.value.data.counts.includedOccurrences).toBe(2);
  });
});
