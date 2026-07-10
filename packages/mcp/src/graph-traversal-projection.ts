import { err, ok, type Result } from '@opensip-cli/core';
import {
  buildOccurrenceCallView,
  codePointSortKey,
  type GraphSourceFilter,
  type OccurrenceCallView,
  type TraversalIdentity,
} from '@opensip-cli/graph/read';

import {
  digestNormalizedQuery,
  groupRows,
  pageRows,
  rejectCursorWithoutGeneration,
  validateCursorBinding,
} from './graph-query-page.js';
import {
  hasTruncatedHopEvidence,
  pathHops,
  pathSymbols,
  projectTraversalNode,
  weakestHopConfidence,
} from './graph-traversal-evidence.js';
import { fromGraphReadError, readError, type McpReadError } from './mcp-error.js';
import { boundedBfs, MAX_WALK_NODES, reconstructPath } from './tools/graph-walk.js';

import type { CatalogGeneration } from './catalog-generation.js';
import type {
  TraversalHopDto,
  TraversalNodeDto,
  TraversalQuery,
  TraversalSnapshot,
} from './graph-read-port.js';
import type { GraphCoverage } from './symbol-dto.js';

interface TraversalProjectionOptions {
  readonly coverage: GraphCoverage;
  readonly page: { readonly limit: number; readonly nextCursor?: string };
  readonly filter: GraphSourceFilter;
  readonly groups?: readonly { readonly key: string; readonly count: number }[];
}

export interface TraversalProjection {
  readonly data: TraversalSnapshot;
  readonly options: TraversalProjectionOptions;
}

interface WalkSelection {
  readonly found: boolean;
  readonly outputKeys: readonly string[];
  readonly visitedKeys: readonly string[];
  readonly parents: ReadonlyMap<string, string>;
  readonly depths: ReadonlyMap<string, number>;
  readonly truncated: boolean;
}

interface IndexedTraversalRow {
  readonly key: string;
  readonly value: TraversalNodeDto;
}

interface FlattenedRows {
  readonly rows: readonly IndexedTraversalRow[];
  readonly totalMembership: number;
  readonly truncated: boolean;
}

interface TraversalAnalysis {
  readonly allRows: readonly TraversalNodeDto[];
  readonly groups?: readonly { readonly key: string; readonly count: number }[];
  readonly groupTruncated: boolean;
  readonly counts: TraversalSnapshot['counts'];
  readonly unresolved: TraversalSnapshot['unresolved'];
  readonly hops?: readonly TraversalHopDto[];
  readonly evidenceTruncated: boolean;
}

export function projectTraversal(
  generation: CatalogGeneration | undefined,
  query: TraversalQuery,
  filter: GraphSourceFilter,
  projectKey: string,
): Result<TraversalProjection, McpReadError> {
  const identity = query.identity ?? 'occurrence';
  const limit = boundedLimit(query.limit);
  const queryDigest = traversalQueryDigest(query, filter, identity);
  if (generation === undefined) {
    const cursor = rejectCursorWithoutGeneration(query.cursor, { projectKey, queryDigest });
    if (!cursor.ok) return cursor;
    return ok(emptyProjection(identity, filter, limit));
  }
  const cursor = validateCursorBinding({
    projectKey,
    generationKey: generation.key,
    queryDigest,
    limit,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });
  if (!cursor.ok) return cursor;
  const start = generation.indexes.byOccId.get(query.startSymbolId);
  if (start === undefined) {
    return err(
      readError(
        'symbol-not-found',
        'Start symbolId is not present in the loaded graph generation.',
      ),
    );
  }
  if (
    query.direction === 'path' &&
    query.goalSymbolId !== undefined &&
    !generation.indexes.byOccId.has(query.goalSymbolId)
  ) {
    return err(
      readError('symbol-not-found', 'Goal symbolId is not present in the loaded graph generation.'),
    );
  }

  const view = buildOccurrenceCallView(generation.catalog, generation.indexes, {
    filter,
    identity,
    startSymbolId: query.startSymbolId,
    goalSymbolId: query.goalSymbolId,
    direction: query.direction === 'path' ? 'callees' : query.direction,
    depth: query.depth ?? 5,
    maxNodes: MAX_WALK_NODES,
  });
  if (!view.ok) return err(fromGraphReadError(view.error));

  const startKey = identity === 'occurrence' ? query.startSymbolId : start.bodyHash;
  if (!view.value.members.has(startKey)) return ok(emptyProjection(identity, filter, limit));
  const selected = selectWalk(generation, view.value, query, startKey, identity);
  return assembleTraversalProjection({
    generation,
    query,
    filter,
    projectKey,
    identity,
    limit,
    view: view.value,
    selected,
  });
}

function assembleTraversalProjection(input: {
  readonly generation: CatalogGeneration;
  readonly query: TraversalQuery;
  readonly filter: GraphSourceFilter;
  readonly projectKey: string;
  readonly identity: TraversalIdentity;
  readonly limit: number;
  readonly view: OccurrenceCallView;
  readonly selected: WalkSelection;
}): Result<TraversalProjection, McpReadError> {
  const { generation, query, filter, projectKey, identity, limit, view, selected } = input;
  const flattened = flattenRows(view, selected, query.direction, identity);
  const binding = {
    projectKey,
    generationKey: generation.key,
    queryDigest: traversalQueryDigest(query, filter, identity),
    limit,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
  const paged = pageRows(flattened.rows, binding, (row) => row.key);
  if (!paged.ok) return paged;

  const analysis = analyzeTraversal(view, selected, flattened, query, identity);
  const reasons = traversalCoverageReasons(view, selected, flattened, analysis);
  const weakest = analysis.hops === undefined ? undefined : weakestHopConfidence(analysis.hops);
  const pageNodes = paged.value.rows.map((row) => row.value);
  const path =
    query.direction === 'path' && selected.found
      ? pathSymbols(view, selected.outputKeys, query, identity)
      : undefined;

  return ok({
    data: {
      found: selected.found,
      nodes: pageNodes,
      ...(path === undefined ? {} : { path }),
      ...(analysis.hops === undefined ? {} : { hops: analysis.hops }),
      ...(weakest === undefined ? {} : { weakestConfidence: weakest }),
      identityMode: identity,
      totalMembership: flattened.totalMembership,
      counts: analysis.counts,
      unresolved: analysis.unresolved,
      unresolvedCounts: view.unresolvedCounts,
      unresolvedAttribution: view.unresolvedAttribution,
    },
    options: {
      coverage: {
        complete: reasons.length === 0,
        truncated:
          view.coverage.truncated ||
          selected.truncated ||
          flattened.truncated ||
          analysis.evidenceTruncated,
        reasons,
      },
      page: {
        limit,
        ...(paged.value.nextCursor === undefined ? {} : { nextCursor: paged.value.nextCursor }),
      },
      filter,
      ...(analysis.groups === undefined ? {} : { groups: analysis.groups }),
    },
  });
}

function analyzeTraversal(
  view: OccurrenceCallView,
  selected: WalkSelection,
  flattened: FlattenedRows,
  query: TraversalQuery,
  identity: TraversalIdentity,
): TraversalAnalysis {
  const allRows = flattened.rows.map((row) => row.value);
  const grouped = groupRows(allRows, query.groupBy ?? 'none', (row, mode) =>
    mode === 'package' ? row.symbol.package : row.symbol.filePath,
  );
  const counts = view.counts;
  const unresolved = view.unresolved;
  const hops =
    query.direction === 'path' ? pathHops(view, selected.outputKeys, identity) : undefined;
  return {
    allRows,
    ...(grouped.groups === undefined ? {} : { groups: grouped.groups }),
    groupTruncated: grouped.groupTruncated,
    counts,
    unresolved,
    ...(hops === undefined ? {} : { hops }),
    evidenceTruncated:
      query.direction === 'path' && hasTruncatedHopEvidence(view, selected.outputKeys, identity),
  };
}

function traversalCoverageReasons(
  view: OccurrenceCallView,
  selected: WalkSelection,
  flattened: FlattenedRows,
  analysis: TraversalAnalysis,
): string[] {
  return [
    ...view.coverage.reasons,
    ...(selected.truncated ? ['walk-node-cap'] : []),
    ...(flattened.truncated ? ['walk-membership-cap'] : []),
    ...(analysis.evidenceTruncated ? ['hop-evidence-cap'] : []),
    ...(analysis.groupTruncated ? ['group-key-cap'] : []),
  ];
}

function selectWalk(
  generation: CatalogGeneration,
  view: OccurrenceCallView,
  query: TraversalQuery,
  startKey: string,
  identity: TraversalIdentity,
): WalkSelection {
  const depth = query.depth ?? 5;
  const adjacency = query.direction === 'callers' ? view.reverse : view.forward;
  if (query.direction !== 'path') {
    const walk = boundedBfs(adjacency, startKey, {
      depth,
      cap: MAX_WALK_NODES,
    });
    return {
      found: true,
      outputKeys: [startKey, ...walk.order],
      visitedKeys: [startKey, ...walk.order],
      parents: walk.parents,
      depths: walk.depths,
      truncated: walk.truncated,
    };
  }
  const goalKey = goalKeyFor(generation, query.goalSymbolId, identity);
  if (goalKey === undefined || !view.members.has(goalKey)) return emptyWalkSelection();
  const walk = boundedBfs(adjacency, startKey, {
    depth,
    cap: MAX_WALK_NODES,
    goal: goalKey,
  });
  const visitedKeys = [startKey, ...walk.order];
  return {
    found: walk.foundGoal,
    outputKeys: walk.foundGoal ? reconstructPath(walk.parents, startKey, goalKey) : [],
    visitedKeys,
    parents: walk.parents,
    depths: walk.depths,
    truncated: walk.truncated,
  };
}

function goalKeyFor(
  generation: CatalogGeneration,
  goalSymbolId: string | undefined,
  identity: TraversalIdentity,
): string | undefined {
  if (goalSymbolId === undefined) return undefined;
  const goal = generation.indexes.byOccId.get(goalSymbolId);
  if (goal === undefined) return undefined;
  return identity === 'occurrence' ? goalSymbolId : goal.bodyHash;
}

function emptyWalkSelection(): WalkSelection {
  return {
    found: false,
    outputKeys: [],
    visitedKeys: [],
    parents: new Map(),
    depths: new Map(),
    truncated: false,
  };
}

function flattenRows(
  view: OccurrenceCallView,
  selected: WalkSelection,
  direction: TraversalQuery['direction'],
  identity: TraversalIdentity,
): FlattenedRows {
  const rows: IndexedTraversalRow[] = [];
  let totalMembership = 0;
  let truncated = false;
  for (const [groupIndex, groupId] of selected.outputKeys.entries()) {
    const members = view.members.get(groupId) ?? [];
    totalMembership += members.length;
    const parent = selected.parents.get(groupId);
    for (const member of members) {
      if (rows.length >= MAX_WALK_NODES) {
        truncated = true;
        continue;
      }
      rows.push({
        key: traversalRowKey(groupIndex, member.symbolId),
        value: projectTraversalNode({
          view,
          parent,
          groupId,
          member,
          groupTotal: members.length,
          depth: selected.depths.get(groupId) ?? groupIndex,
          direction,
          identity,
        }),
      });
    }
  }
  return { rows, totalMembership, truncated };
}

function traversalRowKey(groupIndex: number, symbolId: string): string {
  return `${String(groupIndex).padStart(6, '0')}:${codePointSortKey(symbolId)}`;
}

function traversalQueryDigest(
  query: TraversalQuery,
  filter: GraphSourceFilter,
  identity: TraversalIdentity,
): string {
  return digestNormalizedQuery({
    op: 'traverse',
    direction: query.direction,
    startSymbolId: query.startSymbolId,
    goalSymbolId: query.goalSymbolId,
    depth: query.depth ?? 5,
    identity,
    filter,
    groupBy: query.groupBy ?? 'none',
  });
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(500, Math.trunc(value)));
}

function emptyProjection(
  identityMode: TraversalIdentity,
  filter: GraphSourceFilter,
  limit: number,
): TraversalProjection {
  return {
    data: {
      found: false,
      nodes: [],
      identityMode,
      totalMembership: 0,
      counts: {
        includedOccurrences: 0,
        excludedOccurrences: 0,
        includedEdges: 0,
        excludedEdges: 0,
        countScope: 'visited',
      },
      unresolved: [],
      unresolvedCounts: [],
      unresolvedAttribution: 'owner-only',
    },
    options: {
      coverage: { complete: true, truncated: false, reasons: [] },
      page: { limit },
      filter,
    },
  };
}
