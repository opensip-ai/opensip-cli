/** Bounded deterministic selection/grouping helpers for public read views. */

import { compareCodePointStrings } from '../code-point-order.js';

import type { CoverageFacet, GraphReadFacetCoverage } from './query-contracts.js';

/** One group key and its match count for a bounded grouped read view. */
export interface ReadGroupSummary {
  readonly key: string;
  readonly count: number;
}

// ── P2 Phase 2.1: facet coverage helpers ─────────────────────────

/** A facet the caller did not request — complete, untruncated, contributes nothing. */
export const UNREQUESTED_FACET: CoverageFacet = Object.freeze({
  requested: false,
  complete: true,
  truncated: false,
  reasons: Object.freeze([]),
});

/**
 * Build one {@link CoverageFacet} from its requested flag + accumulated reasons.
 * `-cap` reasons mark truncation; any reason marks incompleteness. Reasons are
 * deduplicated and code-point sorted for deterministic output.
 */
export function makeFacet(requested: boolean, reasons: ReadonlySet<string>): CoverageFacet {
  const values = [...new Set(reasons)].sort(compareCodePointStrings);
  return {
    requested,
    complete: values.length === 0,
    truncated: values.some((reason) => reason.endsWith('-cap')),
    reasons: values,
  };
}

/**
 * Merge two facets of the SAME name (e.g. a view's evidence facet with the MCP
 * pager's projection facet): requested if either is, complete only if both are,
 * truncated if either is, reasons unioned + sorted.
 */
export function mergeFacet(a: CoverageFacet, b: CoverageFacet): CoverageFacet {
  const values = [...new Set([...a.reasons, ...b.reasons])].sort(compareCodePointStrings);
  return {
    requested: a.requested || b.requested,
    complete: a.complete && b.complete,
    truncated: a.truncated || b.truncated,
    reasons: values,
  };
}

/** The four facets that compose a graph read's coverage. */
export interface CoverageFacetSet {
  readonly inventory: CoverageFacet;
  readonly evidence: CoverageFacet;
  readonly grouping: CoverageFacet;
  readonly projection: CoverageFacet;
}

/**
 * Roll a {@link CoverageFacetSet} into full {@link GraphReadFacetCoverage}. The
 * top-level summary aggregates ONLY the requested facets: complete when every
 * requested facet is complete, truncated when any requested facet is, reasons
 * unioned across requested facets. An unrequested facet never leaks into it.
 */
export function rollupFacets(facets: CoverageFacetSet): GraphReadFacetCoverage {
  const requested = [facets.inventory, facets.evidence, facets.grouping, facets.projection].filter(
    (facet) => facet.requested,
  );
  const reasons = [...new Set(requested.flatMap((facet) => [...facet.reasons]))].sort(
    compareCodePointStrings,
  );
  return {
    ...facets,
    complete: requested.every((facet) => facet.complete),
    truncated: requested.some((facet) => facet.truncated),
    reasons,
  };
}

function insertionIndex<T>(
  window: readonly T[],
  row: T,
  compare: (a: T, b: T) => number,
  afterEqual: boolean,
): number {
  let low = 0;
  let high = window.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const current = window[mid];
    const order = current === undefined ? 1 : compare(current, row);
    if (order < 0 || (afterEqual && order === 0)) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Insert into an ascending top-K window without retaining rejected rows. */
export function insertBoundedTopK<T>(
  window: T[],
  row: T,
  cap: number,
  compare: (a: T, b: T) => number,
): void {
  const low = insertionIndex(window, row, compare, true);
  if (window.length >= cap && low >= cap) return;
  window.splice(low, 0, row);
  if (window.length > cap) window.pop();
}

/** Insert into an ascending top-K window while collapsing comparator-equal rows. */
export function insertUniqueBoundedTopK<T>(
  window: T[],
  row: T,
  cap: number,
  compare: (a: T, b: T) => number,
): void {
  const low = insertionIndex(window, row, compare, false);
  const current = window[low];
  if (current !== undefined && compare(current, row) === 0) return;
  if (window.length >= cap && low >= cap) return;
  window.splice(low, 0, row);
  if (window.length > cap) window.pop();
}

/**
 * Deterministically retain the lowest `maxGroups` keys, then count them in a
 * second pass. Memory is O(maxGroups), even when the filtered row set is large.
 */
export function boundedGroups<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  maxGroups = 500,
): { groups: readonly ReadGroupSummary[]; truncated: boolean } {
  return boundedIterableGroups(() => rows, keyOf, maxGroups);
}

/** Two-pass bounded grouping for a repeatable iterable factory. */
export function boundedIterableGroups<T>(
  rows: () => Iterable<T>,
  keyOf: (row: T) => string,
  maxGroups = 500,
): { groups: readonly ReadGroupSummary[]; truncated: boolean } {
  const selected: string[] = [];
  let truncated = false;
  for (const row of rows()) {
    const key = keyOf(row);
    if (selected.includes(key)) continue;
    if (selected.length < maxGroups) {
      insertBoundedTopK(selected, key, maxGroups, compareCodePointStrings);
      continue;
    }
    truncated = true;
    const last = selected.at(-1);
    if (last !== undefined && compareCodePointStrings(key, last) < 0) {
      insertBoundedTopK(selected, key, maxGroups, compareCodePointStrings);
    }
  }

  const counts = new Map(selected.map((key) => [key, 0]));
  for (const row of rows()) {
    const key = keyOf(row);
    const count = counts.get(key);
    if (count !== undefined) counts.set(key, count + 1);
  }
  return {
    groups: selected.map((key) => ({ key, count: counts.get(key) ?? 0 })),
    truncated,
  };
}
