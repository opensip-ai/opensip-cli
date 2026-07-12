import { err, type Result } from '@opensip-cli/core';
import {
  compareCodePointStrings,
  continuationToken,
  searchSymbolOccurrences,
  symbolSearchStableKey,
} from '@opensip-cli/graph/read';

import {
  boundedTopRows,
  digestNormalizedQuery,
  rejectCursorWithoutGeneration,
} from './graph-query-page.js';
import { clampLimit, toSymbolRef } from './graph-read-projection.js';
import { fromGraphReadError } from './mcp-error.js';

import type { CatalogGeneration } from './catalog-generation.js';
import type { SearchSymbolsOptions } from './graph-read-port.js';
import type { McpReadError } from './mcp-error.js';
import type { SqliteGraphQueryContext } from './sqlite-graph-query-context.js';
import type { GraphToolResult, SymbolRef } from './symbol-dto.js';

const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SPAN_CANDIDATES = 500;

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
        if (gen === undefined) return this.context.envelope(undefined, gen, freshness);
        const occ = gen.indexes.byOccId.get(symbolId);
        if (occ === undefined) return this.context.envelope(undefined, gen, freshness);
        const symbol = toSymbolRef(occ);
        return this.context.envelope(symbol, gen, freshness, {
          coverage:
            symbol === undefined
              ? {
                  complete: false,
                  truncated: false,
                  reasons: ['malformed-symbol-omitted'],
                }
              : { complete: true, truncated: false, reasons: [] },
        });
      },
    );
  }

  async searchSymbols(
    query: string,
    opts?: SearchSymbolsOptions,
  ): Promise<Result<GraphToolResult<readonly SymbolRef[]>, McpReadError>> {
    const filter = this.context.resolveFilter(opts?.filter, 'discover');
    const limit = clampLimit(opts?.limit, DEFAULT_SEARCH_LIMIT);
    const match = opts?.match ?? 'substring';
    const groupBy = opts?.groupBy ?? 'none';
    const queryDigest = digestNormalizedQuery({
      op: 'searchSymbols',
      query,
      match,
      filter,
      groupBy,
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
          return this.context.envelope([] as readonly SymbolRef[], gen, freshness, {
            coverage: { complete: true, truncated: false, reasons: [] },
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
        const searched = searchSymbolOccurrences(
          gen.catalog,
          gen.indexes,
          {
            query,
            match,
            filter,
            limit,
            groupBy,
            ...(after.value === undefined ? {} : { afterKey: after.value }),
          },
          matcher.value,
        );
        if (!searched.ok) return err(fromGraphReadError(searched.error));

        const symbols = searched.value.symbols;
        const lastSymbol = symbols.at(-1);
        const nextCursor =
          searched.value.hasMore && lastSymbol !== undefined
            ? this.context.nextCursorFor(
                binding,
                continuationToken(symbolSearchStableKey(lastSymbol)),
              )
            : undefined;
        const coverageReasons = [...searched.value.coverage.reasons];
        return this.context.envelope(symbols, gen, freshness, {
          coverage: {
            complete: coverageReasons.length === 0,
            truncated: searched.value.coverage.truncated,
            reasons: coverageReasons,
          },
          page: { limit, ...(nextCursor === undefined ? {} : { nextCursor }) },
          filter: searched.value.effectiveFilter,
          ...(searched.value.groups === undefined ? {} : { groups: searched.value.groups }),
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
          return this.context.envelope([] as readonly SymbolRef[], gen, freshness);
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
          coverage: {
            complete: reasons.length === 0,
            truncated: capped,
            reasons,
          },
        });
      },
    );
  }
}
