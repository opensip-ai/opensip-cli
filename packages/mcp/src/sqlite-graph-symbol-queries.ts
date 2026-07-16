import { err, ok, type Result } from '@opensip-cli/core';
import {
  compareSymbolRefs,
  makeFacet,
  mergeFacet,
  matchesGraphSourceFilterWithRoles,
  matchesSymbolSearchQuery,
  projectEntityDetail,
  rollupFacets,
  symbolSearchStableKey,
  UNREQUESTED_FACET,
  type GraphSourceFilter,
  type FeatureTable,
  type GraphEntityDetail,
  type SourceRoleMatcher,
  type SymbolSearchMatch,
} from '@opensip-cli/graph/read';

import { validateCompactQueryDetail } from './compact-query-detail.js';
import {
  digestNormalizedQuery,
  groupRows,
  pageRows,
  rejectCursorWithoutGeneration,
} from './graph-query-page.js';
import {
  DEFAULT_IDENTITY_SEARCH_LIMIT,
  type CompactQueryDetail,
  type SearchSymbolsOptions,
  type GraphSymbolLocationDto,
  type SymbolSearchDto,
} from './graph-read-port.js';
import { clampLimit, toSymbolRef } from './graph-read-projection.js';
import { fromGraphReadError, readError } from './mcp-error.js';
import {
  completeInventoryCoverage,
  missingCatalogCoverage,
  inventoryCoverage,
  type SqliteGraphQueryContext,
} from './sqlite-graph-query-context.js';
import { projectSpanCandidates } from './sqlite-graph-span-query.js';

import type { CatalogGeneration } from './catalog-generation.js';
import type { McpReadError } from './mcp-error.js';
import type { GraphToolResult, SymbolRef } from './symbol-dto.js';

interface MatchingSearchRefsInput {
  readonly generation: CatalogGeneration;
  readonly query: string;
  readonly match: SymbolSearchMatch;
  readonly filter: GraphSourceFilter;
  readonly matcher: SourceRoleMatcher;
  readonly inventoryReasons: Set<string>;
}

/**
 * Stream-filter catalog occurrences into the exclusive search inventory without
 * retaining an unbounded array when only a count is needed.
 */
function* matchingSearchRefs(input: MatchingSearchRefsInput): Generator<SymbolRef> {
  const { generation, query, match, filter, matcher, inventoryReasons } = input;
  for (const occurrence of generation.indexes.byOccId.values()) {
    if (occurrence.kind === 'module-init') continue;
    if (!matchesGraphSourceFilterWithRoles(occurrence, filter, matcher)) continue;
    if (!matchesSymbolSearchQuery(occurrence, query, match)) continue;
    const ref = toSymbolRef(occurrence);
    if (ref === undefined) {
      inventoryReasons.add('malformed-symbol-omitted');
      continue;
    }
    yield ref;
  }
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
  const inventory = [
    ...matchingSearchRefs({
      generation: gen,
      query,
      match,
      filter,
      matcher,
      inventoryReasons,
    }),
  ];
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
  constructor(
    private readonly context: SqliteGraphQueryContext,
    private readonly features: (generation: CatalogGeneration) => FeatureTable,
  ) {}

  async resolveSymbolId(
    symbolId: string,
  ): Promise<Result<GraphToolResult<SymbolRef | undefined>, McpReadError>> {
    return this.context.runQuery(
      'resolveSymbolId',
      { identityMode: 'occurrence', sourceScope: 'all' },
      (gen, freshness) => {
        if (gen === undefined) {
          return this.context.envelope(undefined, gen, freshness, {
            coverage: missingCatalogCoverage(),
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

  async entityDetail(
    symbolId: string,
    signal?: AbortSignal,
  ): Promise<Result<GraphToolResult<GraphEntityDetail | null>, McpReadError>> {
    if (signal?.aborted === true) {
      return err(readError('cancelled', 'Entity detail read was cancelled.'));
    }
    return this.context.runQuery(
      'entityDetail',
      { identityMode: 'occurrence', sourceScope: 'all' },
      (gen, freshness) => {
        if (signal?.aborted === true) {
          return err(readError('cancelled', 'Entity detail read was cancelled.'));
        }
        if (gen === undefined) {
          return this.context.envelope(null, gen, freshness, {
            coverage: missingCatalogCoverage(),
          });
        }
        const projected = projectEntityDetail(
          gen.catalog,
          gen.indexes,
          symbolId,
          this.features(gen),
        );
        if (!projected.ok) return err(fromGraphReadError(projected.error));
        return this.context.envelope(projected.value, gen, freshness, {
          coverage: projected.value?.coverage ?? completeInventoryCoverage(),
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
    const detailOk = validateCompactQueryDetail(detail, groupBy);
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
            coverage: missingCatalogCoverage(),
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
    signal?: AbortSignal,
  ): Promise<Result<GraphToolResult<readonly SymbolRef[]>, McpReadError>> {
    const outcome = await this.symbolAtLocation(file, line, 'summary', signal);
    if (!outcome.ok) return outcome;
    return ok({ ...outcome.value, data: outcome.value.data.candidates });
  }

  async symbolAtLocation(
    file: string,
    line: number,
    detail: 'summary' | 'entity',
    signal?: AbortSignal,
  ): Promise<Result<GraphToolResult<GraphSymbolLocationDto>, McpReadError>> {
    if (signal?.aborted === true) {
      return err(readError('cancelled', 'Symbol location read was cancelled.'));
    }
    return this.context.runQuery(
      'symbolAtLocation',
      { identityMode: 'occurrence', sourceScope: 'all' },
      async (gen, freshness) => {
        if (gen === undefined) {
          return this.context.envelope(
            {
              candidates: [],
              ...(detail === 'entity' ? { entity: null } : {}),
            },
            gen,
            freshness,
            {
              coverage: missingCatalogCoverage(),
            },
          );
        }
        const span = await projectSpanCandidates(gen, file, line, signal);
        if (!span.ok) return span;
        if (detail === 'summary' || span.value.candidates.length !== 1) {
          return this.context.envelope({ candidates: span.value.candidates }, gen, freshness, {
            coverage: inventoryCoverage(span.value.reasons),
          });
        }
        const entity = projectEntityDetail(
          gen.catalog,
          gen.indexes,
          span.value.candidates[0].symbolId,
          this.features(gen),
        );
        if (!entity.ok) return err(fromGraphReadError(entity.error));
        const coverage =
          entity.value === null
            ? inventoryCoverage(span.value.reasons)
            : rollupFacets({
                inventory: mergeFacet(
                  entity.value.coverage.inventory,
                  inventoryCoverage(span.value.reasons).inventory,
                ),
                evidence: entity.value.coverage.evidence,
                grouping: entity.value.coverage.grouping,
                projection: entity.value.coverage.projection,
              });
        return this.context.envelope(
          { candidates: span.value.candidates, entity: entity.value },
          gen,
          freshness,
          { coverage },
        );
      },
    );
  }
}
