/**
 * Filter-first public symbol search over catalog occurrences.
 *
 * Match modes (stated in DTO docs):
 * - `substring` — case-insensitive simpleName contains query
 * - `exact` — case-sensitive simpleName equality
 * - `qualified` — case-sensitive qualifiedName equality
 *
 * Filters (including module-init exclusion) run before the bounded top-K
 * window. Results are ordered by qualified name, file, line, column, symbolId
 * (code-point comparison). Retains at most `limit + 1` rows after `afterKey`.
 */

import { err, ok, type Result } from '@opensip-cli/core';

import {
  toGraphSymbolRef,
  type EffectiveGraphSourceFilter,
  type GraphReadCoverage,
  type GraphSourceFilter,
  type GraphSymbolRef,
} from './query-contracts.js';
import { matchesGraphSourceFilter } from './source-filter.js';

import type { GraphReadError } from './types.js';
import type { Catalog, Indexes } from '../types.js';

/** Match semantics for {@link searchSymbolOccurrences}. */
export type SymbolSearchMatch = 'substring' | 'exact' | 'qualified';

export interface SymbolSearchQuery {
  readonly query: string;
  readonly match: SymbolSearchMatch;
  readonly filter: GraphSourceFilter;
  /** Page size; builder retains at most `limit + 1` to prove another page. */
  readonly limit: number;
  /**
   * Exclusive lower bound from a decoded cursor's `afterKey`.
   * Only keys strictly greater (code-point order) are considered.
   */
  readonly afterKey?: string;
}

export interface SymbolSearchView {
  readonly symbols: readonly GraphSymbolRef[];
  /** True when more than `limit` matches exist after `afterKey`. */
  readonly hasMore: boolean;
  readonly effectiveFilter: EffectiveGraphSourceFilter;
  readonly coverage: GraphReadCoverage;
}

function searchError(message: string): GraphReadError {
  return { code: 'GRAPH.READ.SYMBOL_SEARCH', operation: 'analysis', message };
}

/**
 * Stable sort/page key: qualified\0file\0line\0col\0symbolId.
 * Code-point order on this string matches multi-field lexicographic order for
 * the numeric line/column fields when zero-padded; we compare fields separately
 * in {@link compareSymbolRefs} and use this string only for cursor keys.
 */
export function symbolSearchStableKey(ref: GraphSymbolRef): string {
  return `${ref.qualifiedName}\0${ref.filePath}\0${String(ref.line)}\0${String(ref.column)}\0${ref.symbolId}`;
}

/** Code-point multi-field comparison used for deterministic top-K order. */
export function compareSymbolRefs(a: GraphSymbolRef, b: GraphSymbolRef): number {
  if (a.qualifiedName < b.qualifiedName) return -1;
  if (a.qualifiedName > b.qualifiedName) return 1;
  if (a.filePath < b.filePath) return -1;
  if (a.filePath > b.filePath) return 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.column !== b.column) return a.column - b.column;
  if (a.symbolId < b.symbolId) return -1;
  if (a.symbolId > b.symbolId) return 1;
  return 0;
}

function matchesQuery(
  occ: { simpleName: string; qualifiedName: string },
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
 * Search catalog occurrences with filter-first semantics and a bounded top-K
 * window of size `limit + 1` after an optional exclusive `afterKey`.
 *
 * Does not accept regular expressions and does not read source files.
 */
export function searchSymbolOccurrences(
  _catalog: Catalog,
  indexes: Indexes,
  query: SymbolSearchQuery,
): Result<SymbolSearchView, GraphReadError> {
  try {
    const limit = Math.max(1, Math.min(500, Math.trunc(query.limit)));
    const windowCap = limit + 1;
    /** Bounded ascending window of the smallest matching keys after afterKey. */
    const window: GraphSymbolRef[] = [];
    let omittedMalformed = 0;
    const needle = query.query;

    for (const occ of indexes.byOccId.values()) {
      if (occ.kind === 'module-init') continue;
      if (!matchesGraphSourceFilter(occ, query.filter)) continue;
      if (!matchesQuery(occ, needle, query.match)) continue;

      const ref = toGraphSymbolRef(occ);
      if (ref === undefined) {
        omittedMalformed++;
        continue;
      }

      if (query.afterKey !== undefined && symbolSearchStableKey(ref) <= query.afterKey) {
        continue;
      }

      insertBoundedTopK(window, ref, windowCap);
    }

    const hasMore = window.length > limit;
    const symbols = hasMore ? window.slice(0, limit) : window;
    const reasons: string[] = [];
    if (omittedMalformed > 0) reasons.push('malformed-symbol-omitted');

    return ok({
      symbols,
      hasMore,
      effectiveFilter: query.filter,
      coverage: {
        complete: omittedMalformed === 0,
        truncated: false,
        reasons,
      },
    });
  } catch {
    return err(searchError('Failed to search symbol occurrences'));
  }
}

/**
 * Keep the `cap` smallest refs (by {@link compareSymbolRefs}) in ascending order.
 * O(n·cap) insertion; cap is the page window (limit+1 ≤ 501).
 */
function insertBoundedTopK(window: GraphSymbolRef[], ref: GraphSymbolRef, cap: number): void {
  if (window.length < cap) {
    window.push(ref);
    window.sort(compareSymbolRefs);
    return;
  }
  const last = window.at(-1);
  if (last === undefined || compareSymbolRefs(ref, last) >= 0) return;
  window[window.length - 1] = ref;
  window.sort(compareSymbolRefs);
}
