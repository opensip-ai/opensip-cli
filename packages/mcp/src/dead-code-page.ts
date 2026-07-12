/** Bounded filter-first projection over canonical graph orphan findings. */

import { ok, type Result } from '@opensip-cli/core';
import {
  codePointSortKey,
  compareCodePointStrings,
  continuationToken,
  deriveGraphReadFeatures,
  evaluateGraphOrphans,
  makeFacet,
  matchesGraphSourceFilterWithRoles,
  rollupFacets,
  symbolSearchStableKey,
  UNREQUESTED_FACET,
  type FeatureTable,
  type GraphConfig,
  type GraphSourceFilter,
  type SourceRoleMatcher,
} from '@opensip-cli/graph/read';

import { validateCompactQueryDetail } from './compact-query-detail.js';
import { boundedTopRows, groupRows, pageRows, type GroupSummary } from './graph-query-page.js';
import { toDeadCodeDto } from './graph-read-projection.js';

import type { CatalogGeneration } from './catalog-generation.js';
import type { CompactQueryDetail, DeadCodeDto, DeadCodeResultDto } from './graph-read-port.js';
import type { McpReadError } from './mcp-error.js';
import type { GraphCoverage } from './symbol-dto.js';

/** Hard cap separating incomplete orphan evaluation from ordinary pagination. */
export const MAX_ORPHAN_EVALUATION = 10_000;

export interface DeadCodePage {
  readonly data: DeadCodeResultDto;
  readonly hasMore: boolean;
  readonly coverage: GraphCoverage;
  readonly groups?: readonly GroupSummary[];
  readonly nextCursor?: string;
  readonly anchorFound: boolean;
}

export interface DeadCodePageInput {
  readonly generation: CatalogGeneration;
  readonly config: GraphConfig;
  readonly filter: GraphSourceFilter;
  readonly matcher: SourceRoleMatcher;
  readonly limit: number;
  readonly afterKey: string | undefined;
  readonly groupBy: 'none' | 'package' | 'file';
  readonly detail: CompactQueryDetail;
  readonly projectKey: string;
  readonly queryDigest: string;
  readonly cursor?: string;
  readonly cachedFeatures?: FeatureTable;
}

export function deadCodeStableKey(row: DeadCodeDto): string {
  return [
    symbolSearchStableKey(row.symbol),
    codePointSortKey(row.ruleId),
    codePointSortKey(row.reason),
    codePointSortKey(row.message),
    codePointSortKey(row.suggestion ?? ''),
  ].join('|');
}

function countDistribution(
  rows: readonly DeadCodeDto[],
  keyOf: (row: DeadCodeDto) => string,
): readonly { readonly key: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => compareCodePointStrings(a.key, b.key));
}

function resolveDeadAnchor(
  rows: readonly DeadCodeDto[],
  cursorAnchor: string | undefined,
): { readonly found: boolean; readonly stableKey?: string } {
  if (cursorAnchor === undefined) return { found: true };
  for (const row of rows) {
    const stableKey = deadCodeStableKey(row);
    if (continuationToken(stableKey) === cursorAnchor) return { found: true, stableKey };
  }
  return { found: false };
}

function sliceDeadPage(
  selected: readonly DeadCodeDto[],
  afterStableKey: string | undefined,
  limit: number,
): { readonly rows: readonly DeadCodeDto[]; readonly hasMore: boolean } {
  const rows: DeadCodeDto[] = [];
  for (const row of selected) {
    const key = deadCodeStableKey(row);
    if (afterStableKey !== undefined && compareCodePointStrings(key, afterStableKey) <= 0) continue;
    if (rows.length < limit) rows.push(row);
    else return { rows, hasMore: true };
  }
  return { rows, hasMore: false };
}

export function pageDeadCode(input: DeadCodePageInput): Result<DeadCodePage, McpReadError> {
  const {
    generation,
    config,
    filter,
    matcher,
    limit,
    afterKey,
    groupBy,
    detail,
    projectKey,
    queryDigest,
    cursor,
    cachedFeatures,
  } = input;
  const detailOk = validateCompactQueryDetail(detail, groupBy);
  if (!detailOk.ok) return detailOk;

  const features =
    cachedFeatures ??
    deriveGraphReadFeatures(generation.catalog, generation.indexes, config, ['reachableFromEntry']);
  const signals = evaluateGraphOrphans(generation.catalog, generation.indexes, config, features);
  const inventoryReasons = new Set<string>();
  const filteredRows = () =>
    projectFilteredRows(signals, generation, filter, matcher, inventoryReasons);
  const selected = boundedTopRows(filteredRows(), MAX_ORPHAN_EVALUATION, (a, b) =>
    compareCodePointStrings(deadCodeStableKey(a), deadCodeStableKey(b)),
  );
  if (selected.total > MAX_ORPHAN_EVALUATION) inventoryReasons.add('orphan-evaluation-cap');

  const reasonCounts = countDistribution(selected.rows, (row) => row.reason).map((entry) => ({
    reason: entry.key,
    count: entry.count,
  }));
  const ruleCounts = countDistribution(selected.rows, (row) => row.ruleId).map((entry) => ({
    ruleId: entry.key,
    count: entry.count,
  }));
  const totalOrphans = selected.rows.length;

  if (detail === 'summary') {
    return ok({
      data: {
        detail: 'summary',
        rows: [],
        totalOrphans,
        reasonCounts,
        ruleCounts,
      },
      hasMore: false,
      anchorFound: true,
      coverage: rollupFacets({
        inventory: makeFacet(true, inventoryReasons),
        evidence: UNREQUESTED_FACET,
        grouping: UNREQUESTED_FACET,
        projection: UNREQUESTED_FACET,
      }),
    });
  }

  if (detail === 'groups') {
    const grouped = groupRows(selected.rows, groupBy, (row, mode) =>
      mode === 'package' ? row.symbol.package : row.symbol.filePath,
    );
    const groupingReasons = new Set(grouped.groupTruncated ? ['group-key-cap'] : []);
    const paged = pageRows(
      grouped.groups ?? [],
      {
        projectKey,
        generationKey: generation.key,
        queryDigest,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      },
      (group) => group.key,
    );
    if (!paged.ok) return paged;
    return ok({
      data: {
        detail: 'groups',
        rows: [],
        totalOrphans,
        reasonCounts,
        ruleCounts,
      },
      hasMore: paged.value.hasMore,
      anchorFound: true,
      coverage: rollupFacets({
        inventory: makeFacet(true, inventoryReasons),
        evidence: UNREQUESTED_FACET,
        grouping: makeFacet(true, groupingReasons),
        projection: makeFacet(true, new Set()),
      }),
      ...(paged.value.rows.length === 0 ? {} : { groups: paged.value.rows }),
      ...(paged.value.nextCursor === undefined ? {} : { nextCursor: paged.value.nextCursor }),
    });
  }

  // detail === 'nodes'
  const anchor = resolveDeadAnchor(selected.rows, afterKey);
  if (!anchor.found) {
    return ok({
      data: {
        detail: 'nodes',
        rows: [],
        totalOrphans,
        reasonCounts,
        ruleCounts,
      },
      hasMore: false,
      anchorFound: false,
      coverage: rollupFacets({
        inventory: makeFacet(true, inventoryReasons),
        evidence: UNREQUESTED_FACET,
        grouping: UNREQUESTED_FACET,
        projection: makeFacet(true, new Set()),
      }),
    });
  }
  const page = sliceDeadPage(selected.rows, anchor.stableKey, limit);
  return ok({
    data: {
      detail: 'nodes',
      rows: page.rows,
      totalOrphans,
      reasonCounts,
      ruleCounts,
    },
    hasMore: page.hasMore,
    anchorFound: true,
    coverage: rollupFacets({
      inventory: makeFacet(true, inventoryReasons),
      evidence: UNREQUESTED_FACET,
      grouping: UNREQUESTED_FACET,
      projection: makeFacet(true, new Set()),
    }),
  });
}

function* projectFilteredRows(
  signals: ReturnType<typeof evaluateGraphOrphans>,
  generation: CatalogGeneration,
  filter: GraphSourceFilter,
  matcher: SourceRoleMatcher,
  reasons: Set<string>,
): Generator<DeadCodeDto> {
  for (const signal of signals) {
    const row = toDeadCodeDto(signal, generation.indexes);
    if (row === undefined) {
      reasons.add('malformed-dead-code-omitted');
      continue;
    }
    if (matchesGraphSourceFilterWithRoles(row.symbol, filter, matcher)) yield row;
  }
}
