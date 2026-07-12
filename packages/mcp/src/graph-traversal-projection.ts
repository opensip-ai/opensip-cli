import { err, ok, type Result } from '@opensip-cli/core';
import {
  buildOccurrenceCallView,
  codePointSortKey,
  makeFacet,
  rollupFacets,
  UNREQUESTED_FACET,
  type GraphSourceFilter,
  type OccurrenceCallView,
  type SourceRoleMatcher,
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
  CompactQueryDetail,
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

function effectiveDetail(query: TraversalQuery): CompactQueryDetail {
  // Ordered path/hop semantics stay on the path DTO — never compact-summary.
  if (query.direction === 'path') return 'nodes';
  return query.detail ?? 'nodes';
}

function validateTraversalDetail(
  detail: CompactQueryDetail,
  groupBy: 'none' | 'package' | 'file',
  direction: TraversalQuery['direction'],
): Result<void, McpReadError> {
  if (direction === 'path') return ok(undefined);
  if (detail === 'groups' && groupBy === 'none') {
    return err(readError('invalid-query', 'detail=groups requires groupBy package or file.'));
  }
  if ((detail === 'summary' || detail === 'nodes') && groupBy !== 'none') {
    return err(
      readError(
        'invalid-query',
        'detail=summary and detail=nodes require groupBy none (or omit groupBy).',
      ),
    );
  }
  return ok(undefined);
}

export function projectTraversal(
  generation: CatalogGeneration | undefined,
  query: TraversalQuery,
  filter: GraphSourceFilter,
  projectKey: string,
  matcher: SourceRoleMatcher,
): Result<TraversalProjection, McpReadError> {
  const identity = query.identity ?? 'occurrence';
  const limit = boundedLimit(query.limit);
  const detail = effectiveDetail(query);
  const groupBy = query.groupBy ?? 'none';
  const detailOk = validateTraversalDetail(detail, groupBy, query.direction);
  if (!detailOk.ok) return detailOk;

  const queryDigest = traversalQueryDigest(query, filter, identity, detail);
  if (generation === undefined) {
    const cursor = rejectCursorWithoutGeneration(query.cursor, { projectKey, queryDigest });
    if (!cursor.ok) return cursor;
    return ok(emptyProjection(identity, filter, limit, detail));
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

  const view = buildOccurrenceCallView(
    generation.catalog,
    generation.indexes,
    {
      filter,
      identity,
      startSymbolId: query.startSymbolId,
      goalSymbolId: query.goalSymbolId,
      direction: query.direction === 'path' ? 'callees' : query.direction,
      depth: query.depth ?? 5,
      maxNodes: MAX_WALK_NODES,
    },
    matcher,
  );
  if (!view.ok) return err(fromGraphReadError(view.error));

  const startKey = identity === 'occurrence' ? query.startSymbolId : start.bodyHash;
  if (!view.value.members.has(startKey)) {
    return ok(emptyProjection(identity, filter, limit, detail));
  }
  const selected = selectWalk(generation, view.value, query, startKey, identity);
  return assembleTraversalProjection({
    generation,
    query,
    filter,
    projectKey,
    identity,
    limit,
    detail,
    view: view.value,
    selected,
  });
}

type TraversalBaseData = Pick<
  TraversalSnapshot,
  | 'found'
  | 'identityMode'
  | 'totalMembership'
  | 'counts'
  | 'unresolvedAttribution'
  | 'unresolvedCounts'
>;

interface PageBinding {
  readonly projectKey: string;
  readonly generationKey: string;
  readonly queryDigest: string;
  readonly limit: number;
  readonly cursor?: string;
}

function assembleTraversalProjection(input: {
  readonly generation: CatalogGeneration;
  readonly query: TraversalQuery;
  readonly filter: GraphSourceFilter;
  readonly projectKey: string;
  readonly identity: TraversalIdentity;
  readonly limit: number;
  readonly detail: CompactQueryDetail;
  readonly view: OccurrenceCallView;
  readonly selected: WalkSelection;
}): Result<TraversalProjection, McpReadError> {
  const { generation, query, filter, projectKey, identity, limit, detail, view, selected } = input;
  // One bounded walk inventory — exclusive projection chooses summary/groups/nodes.
  const flattened = flattenRows(view, selected, query.direction, identity);
  const analysis = analyzeTraversal(view, selected, flattened, query, identity, detail);
  const binding: PageBinding = {
    projectKey,
    generationKey: generation.key,
    queryDigest: traversalQueryDigest(query, filter, identity, detail),
    limit,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
  const baseData: TraversalBaseData = {
    found: selected.found,
    identityMode: identity,
    totalMembership: flattened.totalMembership,
    counts: analysis.counts,
    unresolvedAttribution: view.unresolvedAttribution,
    unresolvedCounts: view.unresolvedCounts,
  };
  const coverage = facetsForTraversal(view, selected, flattened, analysis, detail);

  if (detail === 'summary') {
    return ok(summaryProjection(baseData, coverage, filter, limit));
  }
  if (detail === 'groups') {
    return groupsProjection(baseData, coverage, filter, analysis.groups ?? [], binding);
  }
  return nodesProjection(baseData, coverage, filter, {
    flattened,
    analysis,
    query,
    selected,
    view,
    identity,
    binding,
  });
}

function summaryProjection(
  baseData: TraversalBaseData,
  coverage: GraphCoverage,
  filter: GraphSourceFilter,
  limit: number,
): TraversalProjection {
  return {
    data: { ...baseData, nodes: [], unresolved: [] },
    options: { coverage, page: { limit }, filter },
  };
}

function groupsProjection(
  baseData: TraversalBaseData,
  coverage: GraphCoverage,
  filter: GraphSourceFilter,
  groups: readonly { readonly key: string; readonly count: number }[],
  binding: PageBinding,
): Result<TraversalProjection, McpReadError> {
  const paged = pageRows(groups, binding, (group) => group.key);
  if (!paged.ok) return paged;
  return ok({
    data: { ...baseData, nodes: [], unresolved: [] },
    options: {
      coverage,
      page: {
        limit: binding.limit,
        ...(paged.value.nextCursor === undefined ? {} : { nextCursor: paged.value.nextCursor }),
      },
      filter,
      ...(paged.value.rows.length === 0 ? {} : { groups: paged.value.rows }),
    },
  });
}

function nodesProjection(
  baseData: TraversalBaseData,
  coverage: GraphCoverage,
  filter: GraphSourceFilter,
  input: {
    readonly flattened: FlattenedRows;
    readonly analysis: TraversalAnalysis;
    readonly query: TraversalQuery;
    readonly selected: WalkSelection;
    readonly view: OccurrenceCallView;
    readonly identity: TraversalIdentity;
    readonly binding: PageBinding;
  },
): Result<TraversalProjection, McpReadError> {
  const { flattened, analysis, query, selected, view, identity, binding } = input;
  const paged = pageRows(flattened.rows, binding, (row) => row.key);
  if (!paged.ok) return paged;
  const pageNodes = paged.value.rows.map((row) => row.value);
  const path =
    query.direction === 'path' && selected.found
      ? pathSymbols(view, selected.outputKeys, query, identity)
      : undefined;
  const weakest = analysis.hops === undefined ? undefined : weakestHopConfidence(analysis.hops);
  return ok({
    data: {
      ...baseData,
      nodes: pageNodes,
      unresolved: analysis.unresolved,
      ...(path === undefined ? {} : { path }),
      ...(analysis.hops === undefined ? {} : { hops: analysis.hops }),
      ...(weakest === undefined ? {} : { weakestConfidence: weakest }),
    },
    options: {
      coverage,
      page: {
        limit: binding.limit,
        ...(paged.value.nextCursor === undefined ? {} : { nextCursor: paged.value.nextCursor }),
      },
      filter,
    },
  });
}

function analyzeTraversal(
  view: OccurrenceCallView,
  selected: WalkSelection,
  flattened: FlattenedRows,
  query: TraversalQuery,
  identity: TraversalIdentity,
  detail: CompactQueryDetail,
): TraversalAnalysis {
  const allRows = flattened.rows.map((row) => row.value);
  const groupBy = detail === 'groups' ? (query.groupBy ?? 'none') : 'none';
  const grouped = groupRows(allRows, groupBy, (row, mode) =>
    mode === 'package' ? row.symbol.package : row.symbol.filePath,
  );
  const hops =
    query.direction === 'path' ? pathHops(view, selected.outputKeys, identity) : undefined;
  return {
    allRows,
    ...(grouped.groups === undefined ? {} : { groups: grouped.groups }),
    groupTruncated: grouped.groupTruncated,
    counts: view.counts,
    unresolved: view.unresolved,
    ...(hops === undefined ? {} : { hops }),
    evidenceTruncated:
      query.direction === 'path' && hasTruncatedHopEvidence(view, selected.outputKeys, identity),
  };
}

function facetsForTraversal(
  view: OccurrenceCallView,
  selected: WalkSelection,
  flattened: FlattenedRows,
  analysis: TraversalAnalysis,
  detail: CompactQueryDetail,
): GraphCoverage {
  const inventoryReasons = new Set<string>([
    ...view.coverage.reasons,
    ...(selected.truncated ? ['walk-node-cap'] : []),
    ...(flattened.truncated ? ['walk-membership-cap'] : []),
  ]);
  const evidenceReasons = new Set<string>(analysis.evidenceTruncated ? ['hop-evidence-cap'] : []);
  const groupingReasons = new Set<string>(
    detail === 'groups' && analysis.groupTruncated ? ['group-key-cap'] : [],
  );
  return rollupFacets({
    inventory: makeFacet(true, inventoryReasons),
    evidence: makeFacet(analysis.evidenceTruncated || detail === 'nodes', evidenceReasons),
    grouping: detail === 'groups' ? makeFacet(true, groupingReasons) : UNREQUESTED_FACET,
    projection: makeFacet(detail !== 'summary', new Set()),
  });
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
  detail: CompactQueryDetail,
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
    detail,
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
  detail: CompactQueryDetail,
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
      coverage: rollupFacets({
        inventory: makeFacet(true, new Set()),
        evidence: UNREQUESTED_FACET,
        grouping: detail === 'groups' ? makeFacet(true, new Set()) : UNREQUESTED_FACET,
        projection: makeFacet(detail !== 'summary', new Set()),
      }),
      page: { limit },
      filter,
    },
  };
}
