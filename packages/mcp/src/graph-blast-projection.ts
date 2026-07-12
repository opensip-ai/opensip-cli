import { ok, type Result } from '@opensip-cli/core';
import {
  codePointSortKey,
  compareCodePointStrings,
  matchesGraphSourceFilterWithRoles,
  type GraphSourceFilter,
  type SourceRoleMatcher,
} from '@opensip-cli/graph/read';

import { digestNormalizedQuery, groupRows, pageRows } from './graph-query-page.js';
import { toSymbolRef } from './graph-read-projection.js';

import type { CatalogGeneration } from './catalog-generation.js';
import type { GraphReadPort } from './graph-read-port.js';
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
  const queryDigest = blastQueryDigest(symbolId, filter, options?.groupBy ?? 'none');
  const paged = pageRows(
    matching,
    {
      projectKey,
      generationKey: generation.key,
      queryDigest,
      limit,
      ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
    },
    (symbol) => codePointSortKey(symbol.symbolId),
  );
  if (!paged.ok) return paged;
  const grouped = groupRows(matching, options?.groupBy ?? 'none', (symbol, mode) =>
    mode === 'package' ? symbol.package : symbol.filePath,
  );
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
  const reasons = [
    ...(malformed > 0 ? ['malformed-symbol-omitted'] : []),
    ...(duplicates > 0 ? ['duplicate-symbol-omitted'] : []),
    ...(membershipCapped ? ['blast-membership-cap'] : []),
    ...filteringLimitations,
    ...(grouped.groupTruncated ? ['group-key-cap'] : []),
  ];

  return ok({
    ...(requested === undefined ? {} : { requested }),
    members: paged.value.rows,
    totalMembership: matching.length,
    twinCount: allOccurrences.length,
    filteringLimitations,
    options: {
      coverage: {
        complete: reasons.length === 0,
        truncated: grouped.groupTruncated || membershipCapped,
        reasons,
      },
      page: {
        limit,
        ...(paged.value.nextCursor === undefined ? {} : { nextCursor: paged.value.nextCursor }),
      },
      filter,
      ...(grouped.groups === undefined ? {} : { groups: grouped.groups }),
    },
  });
}

export function blastQueryDigest(
  symbolId: string,
  filter: GraphSourceFilter,
  groupBy: 'none' | 'package' | 'file',
): string {
  return digestNormalizedQuery({ op: 'blast', symbolId, filter, groupBy });
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(500, Math.trunc(value)));
}
