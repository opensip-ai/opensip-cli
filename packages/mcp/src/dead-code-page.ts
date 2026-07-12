/** Bounded filter-first projection over canonical graph orphan findings. */

import {
  codePointSortKey,
  compareCodePointStrings,
  continuationToken,
  deriveGraphReadFeatures,
  evaluateGraphOrphans,
  matchesGraphSourceFilterWithRoles,
  symbolSearchStableKey,
  type FeatureTable,
  type GraphConfig,
  type GraphSourceFilter,
  type SourceRoleMatcher,
} from '@opensip-cli/graph/read';

import { boundedTopRows, groupRows, type GroupSummary } from './graph-query-page.js';
import { toDeadCodeDto } from './graph-read-projection.js';

import type { CatalogGeneration } from './catalog-generation.js';
import type { DeadCodeDto } from './graph-read-port.js';
import type { GraphCoverage } from './symbol-dto.js';

/** Hard cap separating incomplete orphan evaluation from ordinary pagination. */
export const MAX_ORPHAN_EVALUATION = 10_000;

export interface DeadCodePage {
  readonly rows: readonly DeadCodeDto[];
  readonly hasMore: boolean;
  readonly coverage: GraphCoverage;
  readonly groups?: readonly GroupSummary[];
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

export function pageDeadCode(input: DeadCodePageInput): DeadCodePage {
  const { generation, config, filter, matcher, limit, afterKey, groupBy, cachedFeatures } = input;
  const features =
    cachedFeatures ??
    deriveGraphReadFeatures(generation.catalog, generation.indexes, config, ['reachableFromEntry']);
  const signals = evaluateGraphOrphans(generation.catalog, generation.indexes, config, features);
  const reasons = new Set<string>();
  const filteredRows = () => projectFilteredRows(signals, generation, filter, matcher, reasons);
  const selected = boundedTopRows(filteredRows(), MAX_ORPHAN_EVALUATION, (a, b) =>
    compareCodePointStrings(deadCodeStableKey(a), deadCodeStableKey(b)),
  );
  if (selected.total > MAX_ORPHAN_EVALUATION) reasons.add('orphan-evaluation-cap');
  const grouped = groupRows(selected.rows, groupBy, (row, mode) =>
    mode === 'package' ? row.symbol.package : row.symbol.filePath,
  );
  if (grouped.groupTruncated) reasons.add('group-key-cap');

  const anchor = resolveDeadAnchor(selected.rows, afterKey);
  const page = sliceDeadPage(selected.rows, anchor.stableKey, limit);

  const uniqueReasons = [...reasons].sort(compareCodePointStrings);
  return {
    rows: page.rows,
    hasMore: page.hasMore,
    anchorFound: anchor.found,
    coverage: {
      complete: uniqueReasons.length === 0,
      truncated: uniqueReasons.some((reason) => reason.endsWith('-cap')),
      reasons: uniqueReasons,
    },
    ...(grouped.groups === undefined ? {} : { groups: grouped.groups }),
  };
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
