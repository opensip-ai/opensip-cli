import { ok, type Result } from '@opensip-cli/core';
import {
  codePointSortKey,
  compareCodePointStrings,
  makeFacet,
  matchesGraphSourceFilterWithRoles,
  rollupFacets,
  UNREQUESTED_FACET,
  type GraphSourceFilter,
  type SourceRoleMatcher,
} from '@opensip-cli/graph/read';

import { validateCompactQueryDetail, type CompactGroupBy } from './compact-query-detail.js';
import { digestNormalizedQuery, groupRows, pageRows } from './graph-query-page.js';
import { toSymbolRef } from './graph-read-projection.js';

import type { CatalogGeneration } from './catalog-generation.js';
import type { CompactQueryDetail, GraphReadPort } from './graph-read-port.js';
import type { McpReadError } from './mcp-error.js';
import type { GraphCoverage, SymbolRef } from './symbol-dto.js';

type BlastOptions = Parameters<GraphReadPort['blast']>[1];
const MAX_BLAST_OCCURRENCES = 20_000;

interface BlastProjectionOptions {
  readonly coverage: GraphCoverage;
  readonly page: { readonly limit: number; readonly nextCursor?: string };
  readonly filter: GraphSourceFilter;
  readonly groups?: readonly { readonly key: string; readonly count: number }[];
}

export interface BlastMemberProjection {
  readonly requested?: SymbolRef;
  readonly members: readonly SymbolRef[];
  readonly totalMembership: number;
  readonly twinCount: number;
  readonly filteringLimitations: readonly string[];
  readonly detail: CompactQueryDetail;
  readonly options: BlastProjectionOptions;
}

export interface BlastMemberProjectionInput {
  readonly generation: CatalogGeneration;
  readonly bodyHash: string;
  readonly symbolId: string;
  readonly filter: GraphSourceFilter;
  readonly matcher: SourceRoleMatcher;
  readonly options: BlastOptions;
  readonly projectKey: string;
}

export function projectBlastMembers(
  input: BlastMemberProjectionInput,
): Result<BlastMemberProjection, McpReadError> {
  const { generation, bodyHash, symbolId, filter, matcher, options, projectKey } = input;
  const limit = boundedLimit(options?.limit);
  const detail: CompactQueryDetail = options?.detail ?? 'summary';
  const groupBy = options?.groupBy ?? 'none';
  const detailOk = validateCompactQueryDetail(detail, groupBy);
  if (!detailOk.ok) return detailOk;

  const allOccurrences = generation.indexes.occurrencesByHash.get(bodyHash) ?? [];
  const membershipCapped = allOccurrences.length > MAX_BLAST_OCCURRENCES;
  const projectedRows = allOccurrences
    .slice(0, MAX_BLAST_OCCURRENCES)
    .map((occurrence) => toSymbolRef(occurrence))
    .filter((symbol): symbol is SymbolRef => symbol !== undefined)
    .sort((left, right) => compareCodePointStrings(left.symbolId, right.symbolId));
  const projected = projectedRows.filter(
    (symbol, index) => index === 0 || projectedRows[index - 1]?.symbolId !== symbol.symbolId,
  );
  const matching = projected.filter((symbol) =>
    matchesGraphSourceFilterWithRoles(symbol, filter, matcher),
  );
  const requestedOccurrence = generation.indexes.byOccId.get(symbolId);
  const requested =
    requestedOccurrence?.bodyHash === bodyHash ? toSymbolRef(requestedOccurrence) : undefined;

  const examinedOccurrences = Math.min(allOccurrences.length, MAX_BLAST_OCCURRENCES);
  const malformed = examinedOccurrences - projectedRows.length;
  const duplicates = projectedRows.length - projected.length;
  const scoreIncludesFilteredTwins = matching.length !== projected.length;
  const filteringLimitations = [
    ...(scoreIncludesFilteredTwins ? ['canonical-score-includes-filtered-twins'] : []),
    ...(requested !== undefined && !matching.some((symbol) => symbol.symbolId === symbolId)
      ? ['requested-symbol-excluded-by-filter']
      : []),
  ];
  const inventoryReasons = new Set([
    ...(malformed > 0 ? ['malformed-symbol-omitted'] : []),
    ...(duplicates > 0 ? ['duplicate-symbol-omitted'] : []),
    ...(membershipCapped ? ['blast-membership-cap'] : []),
    ...filteringLimitations,
  ]);

  const queryDigest = blastQueryDigest(symbolId, filter, groupBy, detail);
  const binding = {
    projectKey,
    generationKey: generation.key,
    queryDigest,
    limit,
    ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
  };
  const common = {
    ...(requested === undefined ? {} : { requested }),
    totalMembership: matching.length,
    twinCount: allOccurrences.length,
    filteringLimitations,
    detail,
  } as const;

  return projectExclusiveBlast({
    common,
    matching,
    groupBy,
    detail,
    binding,
    filter,
    inventoryReasons,
    limit,
  });
}

function projectExclusiveBlast(input: {
  readonly common: {
    readonly requested?: SymbolRef;
    readonly totalMembership: number;
    readonly twinCount: number;
    readonly filteringLimitations: readonly string[];
    readonly detail: CompactQueryDetail;
  };
  readonly matching: readonly SymbolRef[];
  readonly groupBy: CompactGroupBy;
  readonly detail: CompactQueryDetail;
  readonly binding: {
    readonly projectKey: string;
    readonly generationKey: string;
    readonly queryDigest: string;
    readonly limit: number;
    readonly cursor?: string;
  };
  readonly filter: GraphSourceFilter;
  readonly inventoryReasons: ReadonlySet<string>;
  readonly limit: number;
}): Result<BlastMemberProjection, McpReadError> {
  const { common, matching, groupBy, detail, binding, filter, inventoryReasons, limit } = input;
  if (detail === 'summary') {
    return ok({
      ...common,
      members: [],
      options: {
        coverage: rollupFacets({
          inventory: makeFacet(true, inventoryReasons),
          evidence: UNREQUESTED_FACET,
          grouping: UNREQUESTED_FACET,
          projection: UNREQUESTED_FACET,
        }),
        page: { limit },
        filter,
      },
    });
  }
  if (detail === 'groups') {
    const grouped = groupRows(matching, groupBy, (symbol, mode) =>
      mode === 'package' ? symbol.package : symbol.filePath,
    );
    const paged = pageRows(grouped.groups ?? [], binding, (group) => group.key);
    if (!paged.ok) return paged;
    const groupingReasons = new Set(grouped.groupTruncated ? ['group-key-cap'] : []);
    return ok({
      ...common,
      members: [],
      options: {
        coverage: rollupFacets({
          inventory: makeFacet(true, inventoryReasons),
          evidence: UNREQUESTED_FACET,
          grouping: makeFacet(true, groupingReasons),
          projection: makeFacet(true, new Set()),
        }),
        page: {
          limit,
          ...(paged.value.nextCursor === undefined ? {} : { nextCursor: paged.value.nextCursor }),
        },
        filter,
        ...(paged.value.rows.length === 0 ? {} : { groups: paged.value.rows }),
      },
    });
  }
  const paged = pageRows(matching, binding, (symbol) => codePointSortKey(symbol.symbolId));
  if (!paged.ok) return paged;
  return ok({
    ...common,
    members: paged.value.rows,
    options: {
      coverage: rollupFacets({
        inventory: makeFacet(true, inventoryReasons),
        evidence: UNREQUESTED_FACET,
        grouping: UNREQUESTED_FACET,
        projection: makeFacet(true, new Set()),
      }),
      page: {
        limit,
        ...(paged.value.nextCursor === undefined ? {} : { nextCursor: paged.value.nextCursor }),
      },
      filter,
    },
  });
}

export function blastQueryDigest(
  symbolId: string,
  filter: GraphSourceFilter,
  groupBy: 'none' | 'package' | 'file',
  detail: CompactQueryDetail = 'summary',
): string {
  return digestNormalizedQuery({ op: 'blast', symbolId, filter, groupBy, detail });
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(500, Math.trunc(value)));
}
