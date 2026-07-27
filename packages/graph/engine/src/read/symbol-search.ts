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
 * (code-point comparison). Continuation uses a compact hash identity, not the
 * potentially large raw tuple.
 */

import { err, ok, type Result } from '@opensip-cli/core';

import {
  codePointSortKey,
  compareCodePointStrings,
  matchesContinuationIdentity,
} from '../code-point-order.js';

import {
  boundedIterableGroups,
  clampLimit,
  insertBoundedTopK,
  isCapReason,
  type ReadGroupSummary,
} from './bounded-view.js';
import {
  toGraphSymbolRef,
  type EffectiveGraphSourceFilter,
  type GraphReadCoverage,
  type GraphSourceFilter,
  type GraphSymbolRef,
} from './query-contracts.js';
import { matchesGraphSourceFilterWithRoles, type SourceRoleMatcher } from './source-filter.js';

import type { GraphReadError } from './types.js';
import type { Catalog, Indexes } from '../types.js';

// Plan 01: the `GRAPH` head was mapped by nothing, so every one of these resolved to
// UNKNOWN_FAILURE — fatal and operator-only — for conditions MCP consumers branch on.

/** Fallback page size when a caller-supplied `limit` is absent/non-finite —
 * matches the documented identity-search default (20 nodes). */
const DEFAULT_SEARCH_LIMIT = 20;

/** Match semantics for {@link searchSymbolOccurrences}. */
export type SymbolSearchMatch = 'substring' | 'exact' | 'qualified';

/** Match, filtering, grouping, and continuation options for symbol search. */
export interface SymbolSearchQuery {
  readonly query: string;
  readonly match: SymbolSearchMatch;
  readonly filter: GraphSourceFilter;
  /** Page size; builder retains at most `limit + 1` to prove another page. */
  readonly limit: number;
  /**
   * Compact continuation token for the last row of the preceding page.
   */
  readonly afterKey?: string;
  readonly groupBy?: 'none' | 'package' | 'file';
}

/** Bounded symbol-search results with effective filters and coverage metadata. */
export interface SymbolSearchView {
  readonly symbols: readonly GraphSymbolRef[];
  /** True when more than `limit` matches exist after `afterKey`. */
  readonly hasMore: boolean;
  readonly effectiveFilter: EffectiveGraphSourceFilter;
  readonly coverage: GraphReadCoverage;
  readonly groups?: readonly ReadGroupSummary[];
}

function searchError(message: string): GraphReadError {
  return { code: 'query-invalid', operation: 'analysis', message };
}

/**
 * Printable stable key matching qualified/file/line/column/symbolId ordering.
 */
export function symbolSearchStableKey(ref: GraphSymbolRef): string {
  return [
    codePointSortKey(ref.qualifiedName),
    codePointSortKey(ref.filePath),
    String(ref.line).padStart(16, '0'),
    String(ref.column).padStart(16, '0'),
    codePointSortKey(ref.symbolId),
  ].join('|');
}

/** Code-point multi-field comparison used for deterministic top-K order. */
export function compareSymbolRefs(a: GraphSymbolRef, b: GraphSymbolRef): number {
  const qualified = compareCodePointStrings(a.qualifiedName, b.qualifiedName);
  if (qualified !== 0) return qualified;
  const file = compareCodePointStrings(a.filePath, b.filePath);
  if (file !== 0) return file;
  if (a.line !== b.line) return a.line - b.line;
  if (a.column !== b.column) return a.column - b.column;
  return compareCodePointStrings(a.symbolId, b.symbolId);
}

function* matchingSymbolRefs(
  indexes: Indexes,
  query: SymbolSearchQuery,
  matcher: SourceRoleMatcher,
): Generator<GraphSymbolRef> {
  for (const occurrence of indexes.byOccId.values()) {
    if (occurrence.kind === 'module-init') continue;
    if (!matchesGraphSourceFilterWithRoles(occurrence, query.filter, matcher)) continue;
    if (!matchesSymbolSearchQuery(occurrence, query.query, query.match)) continue;
    const ref = toGraphSymbolRef(occurrence);
    if (ref !== undefined) yield ref;
  }
}

/**
 * Shared match semantics for symbol search (substring / exact / qualified).
 * Exported so MCP and other readers reuse one implementation.
 */
export function matchesSymbolSearchQuery(
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

function collectSearchWindow(
  indexes: Indexes,
  query: SymbolSearchQuery,
  windowCap: number,
  matcher: SourceRoleMatcher,
): { readonly window: GraphSymbolRef[]; readonly omittedMalformed: number } {
  const window: GraphSymbolRef[] = [];
  let omittedMalformed = 0;
  for (const occurrence of indexes.byOccId.values()) {
    if (occurrence.kind === 'module-init') continue;
    if (!matchesGraphSourceFilterWithRoles(occurrence, query.filter, matcher)) continue;
    if (!matchesSymbolSearchQuery(occurrence, query.query, query.match)) continue;
    const ref = toGraphSymbolRef(occurrence);
    if (ref === undefined) {
      omittedMalformed++;
      continue;
    }
    if (
      query.afterKey !== undefined &&
      compareCodePointStrings(symbolSearchStableKey(ref), query.afterKey) <= 0
    ) {
      continue;
    }
    insertBoundedTopK(window, ref, windowCap, compareSymbolRefs);
  }
  return { window, omittedMalformed };
}

function resolveAfterStableKey(
  indexes: Indexes,
  query: SymbolSearchQuery,
  matcher: SourceRoleMatcher,
): string | null | undefined {
  if (query.afterKey === undefined) return undefined;
  for (const ref of matchingSymbolRefs(indexes, query, matcher)) {
    const stableKey = symbolSearchStableKey(ref);
    if (matchesContinuationIdentity(stableKey, query.afterKey)) return stableKey;
  }
  return null;
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
  matcher: SourceRoleMatcher,
): Result<SymbolSearchView, GraphReadError> {
  try {
    // Self-defending clamp: a non-finite caller limit coerces to the default
    // instead of NaN-poisoning the window (which read as an empty result
    // labeled complete: true).
    const limit = clampLimit(query.limit, DEFAULT_SEARCH_LIMIT);
    const windowCap = limit + 1;
    const afterStableKey = resolveAfterStableKey(indexes, query, matcher);
    if (afterStableKey === null) {
      return err({
        code: 'cursor-invalid',
        operation: 'analysis',
        message: 'Cursor continuation anchor is not present in this catalog view',
      });
    }
    const resolvedQuery = {
      ...query,
      ...(afterStableKey === undefined ? {} : { afterKey: afterStableKey }),
    };
    const { window, omittedMalformed } = collectSearchWindow(
      indexes,
      resolvedQuery,
      windowCap,
      matcher,
    );

    const hasMore = window.length > limit;
    const symbols = hasMore ? window.slice(0, limit) : window;
    const reasons: string[] = [];
    if (omittedMalformed > 0) reasons.push('malformed-symbol-omitted');
    const groupBy = query.groupBy ?? 'none';
    const grouped =
      groupBy === 'none'
        ? undefined
        : boundedIterableGroups(
            () => matchingSymbolRefs(indexes, query, matcher),
            (ref) => (groupBy === 'package' ? ref.package : ref.filePath),
          );
    if (grouped?.truncated === true) reasons.push('group-key-cap');

    return ok({
      symbols,
      hasMore,
      effectiveFilter: query.filter,
      ...(grouped === undefined ? {} : { groups: grouped.groups }),
      coverage: {
        complete: reasons.length === 0,
        truncated: reasons.some(isCapReason),
        reasons,
      },
    });
  } catch {
    return err(searchError('Failed to search symbol occurrences'));
  }
}
