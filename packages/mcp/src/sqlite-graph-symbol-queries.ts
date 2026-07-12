import { err, ok, type Result } from '@opensip-cli/core';
import {
  compareCodePointStrings,
  compareSymbolRefs,
  makeFacet,
  matchesGraphSourceFilterWithRoles,
  rollupFacets,
  symbolSearchStableKey,
  UNREQUESTED_FACET,
  type GraphSourceFilter,
  type SourceRoleMatcher,
} from '@opensip-cli/graph/read';

import {
  boundedTopRows,
  digestNormalizedQuery,
  groupRows,
  pageRows,
  rejectCursorWithoutGeneration,
} from './graph-query-page.js';
import {
  DEFAULT_IDENTITY_SEARCH_LIMIT,
  type CompactQueryDetail,
  type SearchSymbolsOptions,
  type SymbolSearchDto,
} from './graph-read-port.js';
import { clampLimit, toSymbolRef } from './graph-read-projection.js';
import { readError } from './mcp-error.js';
import {
  completeInventoryCoverage,
  inventoryCoverage,
  type SqliteGraphQueryContext,
} from './sqlite-graph-query-context.js';

import type { CatalogGeneration } from './catalog-generation.js';
import type { McpReadError } from './mcp-error.js';
import type { GraphToolResult, SymbolRef } from './symbol-dto.js';

const MAX_SPAN_CANDIDATES = 500;

type SymbolSearchMatch = 'substring' | 'exact' | 'qualified';

interface SpanCandidateState {
  malformed: boolean;
}

function* spanCandidates(
  generation: CatalogGeneration,
  file: string,
  line: number,
  state: SpanCandidateState,
): Generator<SymbolRef> {
  for (const occurrence of generation.indexes.byOccId.values()) {
    if (occurrence.filePath !== file || occurrence.line > line || line > occurrence.endLine) {
      continue;
    }
    const ref = toSymbolRef(occurrence);
    if (ref === undefined) state.malformed = true;
    else yield ref;
  }
}

function matchesSearchQuery(
  occ: { readonly simpleName: string; readonly qualifiedName: string },
  query: string,
  match: SymbolSearchMatch,
): boolean {
  switch (match) {
    case 'substring': {
      return occ.simpleName.toLowerCase().includes(query.toLowerCase());
    }
    case 'exact': {
      return occ.simpleName === query;
    }
    case 'qualified': {
      return occ.qualifiedName === query;
    }
    default: {
      const _exhaustive: never = match;
      return _exhaustive;
    }
  }
}

/**
 * Stream-filter catalog occurrences into the exclusive search inventory without
 * retaining an unbounded array when only a count is needed.
 */
function* matchingSearchRefs(
  generation: CatalogGeneration,
  query: string,
  match: SymbolSearchMatch,
  filter: GraphSourceFilter,
  matcher: SourceRoleMatcher,
  inventoryReasons: Set<string>,
): Generator<SymbolRef> {
  for (const occurrence of generation.indexes.byOccId.values()) {
    if (occurrence.kind === 'module-init') continue;
    if (!matchesGraphSourceFilterWithRoles(occurrence, filter, matcher)) continue;
    if (!matchesSearchQuery(occurrence, query, match)) continue;
    const ref = toSymbolRef(occurrence);
    if (ref === undefined) {
      inventoryReasons.add('malformed-symbol-omitted');
      continue;
    }
    yield ref;
  }
}

function validateSearchDetail(
  detail: CompactQueryDetail,
  groupBy: 'none' | 'package' | 'file',
): Result<void, McpReadError> {
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

function emptySearchDto(detail: CompactQueryDetail): SymbolSearchDto {
  return { detail, symbols: [], totalMatches: 0 };
}

interface SearchProjectionInput {
  readonly context: SqliteGraphQueryContext;
  readonly gen: CatalogGeneration;
  readonly freshness: GraphToolResult<unknown>['freshness'];
  readonly query: string;
  readonly match: SymbolSearchMatch;
  readonly filter: GraphSourceFilter;
  readonly matcher: SourceRoleMatcher;
  readonly detail: CompactQueryDetail;
  readonly groupBy: 'none' | 'package' | 'file';
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly binding: {
    readonly projectKey: string;
    readonly generationKey: string;
    readonly queryDigest: string;
  };
}

/**
 * One filtered inventory → exactly one exclusive representation (summary | groups | nodes).
 */
function projectExclusiveSearch(
  input: SearchProjectionInput,
): Result<GraphToolResult<SymbolSearchDto>, McpReadError> {
  const {
    context,
    gen,
    freshness,
    query,
    match,
    filter,
    matcher,
    detail,
    groupBy,
    limit,
    cursor,
    binding,
  } = input;
  const inventoryReasons = new Set<string>();
  const inventory = [...matchingSearchRefs(gen, query, match, filter, matcher, inventoryReasons)];
  inventory.sort(compareSymbolRefs);
  const totalMatches = inventory.length;
  const pageInput = {
    ...binding,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  };

  if (detail === 'summary') {
    return ok(
      context.envelope({ detail: 'summary', symbols: [], totalMatches }, gen, freshness, {
        coverage: rollupFacets({
          inventory: makeFacet(true, inventoryReasons),
          evidence: UNREQUESTED_FACET,
          grouping: UNREQUESTED_FACET,
          projection: UNREQUESTED_FACET,
        }),
        page: { limit },
        filter,
      }),
    );
  }

  if (detail === 'groups') {
    const grouped = groupRows(inventory, groupBy, (symbol, mode) =>
      mode === 'package' ? symbol.package : symbol.filePath,
    );
    const paged = pageRows(grouped.groups ?? [], pageInput, (group) => group.key);
    if (!paged.ok) return paged;
    const groupingReasons = new Set(grouped.groupTruncated ? ['group-key-cap'] : []);
    return ok(
      context.envelope({ detail: 'groups', symbols: [], totalMatches }, gen, freshness, {
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
      }),
    );
  }

  // detail === 'nodes' — page symbols only; grouping unrequested.
  const paged = pageRows(inventory, pageInput, (symbol) => symbolSearchStableKey(symbol));
  if (!paged.ok) return paged;
  return ok(
    context.envelope({ detail: 'nodes', symbols: paged.value.rows, totalMatches }, gen, freshness, {
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
    }),
  );
}

/** Implements occurrence resolution, search, and source-span lookup. */
export class SqliteGraphSymbolQueries {
  constructor(private readonly context: SqliteGraphQueryContext) {}

  async resolveSymbolId(
    symbolId: string,
  ): Promise<Result<GraphToolResult<SymbolRef | undefined>, McpReadError>> {
    return this.context.runQuery(
      'resolveSymbolId',
      { identityMode: 'occurrence', sourceScope: 'all' },
      (gen, freshness) => {
        if (gen === undefined) {
          return this.context.envelope(undefined, gen, freshness, {
            coverage: completeInventoryCoverage(),
          });
        }
        const occ = gen.indexes.byOccId.get(symbolId);
        if (occ === undefined) {
          return this.context.envelope(undefined, gen, freshness, {
            coverage: completeInventoryCoverage(),
          });
        }
        const symbol = toSymbolRef(occ);
        return this.context.envelope(symbol, gen, freshness, {
          coverage:
            symbol === undefined
              ? inventoryCoverage(['malformed-symbol-omitted'])
              : completeInventoryCoverage(),
        });
      },
    );
  }

  async searchSymbols(
    query: string,
    opts?: SearchSymbolsOptions,
  ): Promise<Result<GraphToolResult<SymbolSearchDto>, McpReadError>> {
    const filter = this.context.resolveFilter(opts?.filter, 'discover');
    const limit = clampLimit(opts?.limit, DEFAULT_IDENTITY_SEARCH_LIMIT);
    const match = opts?.match ?? 'substring';
    const groupBy = opts?.groupBy ?? 'none';
    const detail: CompactQueryDetail = opts?.detail ?? 'nodes';
    const detailOk = validateSearchDetail(detail, groupBy);
    if (!detailOk.ok) return detailOk;

    const queryDigest = digestNormalizedQuery({
      op: 'searchSymbols',
      query,
      match,
      filter,
      groupBy,
      detail,
    });
    return this.context.runQuery(
      'searchSymbols',
      { identityMode: 'occurrence', sourceScope: filter.sourceScope },
      (gen, freshness) => {
        if (gen === undefined) {
          const cursor = rejectCursorWithoutGeneration(opts?.cursor, {
            projectKey: this.context.projectKey,
            queryDigest,
          });
          if (!cursor.ok) return cursor;
          return this.context.envelope(emptySearchDto(detail), gen, freshness, {
            coverage: completeInventoryCoverage(),
            page: { limit },
            filter,
          });
        }

        const binding = {
          projectKey: this.context.projectKey,
          generationKey: gen.key,
          queryDigest,
        };
        const after = this.context.resolveAfterKey(opts?.cursor, binding);
        if (!after.ok) return after;
        const matcher = this.context.sourceRoleMatcherFor(gen);
        if (!matcher.ok) return matcher;

        return projectExclusiveSearch({
          context: this.context,
          gen,
          freshness,
          query,
          match,
          filter,
          matcher: matcher.value,
          detail,
          groupBy,
          limit,
          cursor: opts?.cursor,
          binding,
        });
      },
    );
  }

  async findBySpan(
    file: string,
    line: number,
  ): Promise<Result<GraphToolResult<readonly SymbolRef[]>, McpReadError>> {
    return this.context.runQuery(
      'findBySpan',
      { identityMode: 'occurrence', sourceScope: 'all' },
      (gen, freshness) => {
        if (gen === undefined) {
          return this.context.envelope([] as readonly SymbolRef[], gen, freshness, {
            coverage: completeInventoryCoverage(),
          });
        }
        const state: SpanCandidateState = { malformed: false };
        const selected = boundedTopRows(
          spanCandidates(gen, file, line, state),
          MAX_SPAN_CANDIDATES + 1,
          (left, right) => compareCodePointStrings(left.symbolId, right.symbolId),
        );
        const capped = selected.total > MAX_SPAN_CANDIDATES;
        const reasons = [
          ...(state.malformed ? ['malformed-symbol-omitted'] : []),
          ...(capped ? ['span-candidate-cap'] : []),
        ];
        return this.context.envelope(selected.rows.slice(0, MAX_SPAN_CANDIDATES), gen, freshness, {
          coverage: inventoryCoverage(reasons),
        });
      },
    );
  }
}
