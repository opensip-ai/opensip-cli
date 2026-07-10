/** Bounded deterministic selection/grouping helpers for public read views. */

import { compareCodePointStrings } from '../code-point-order.js';

import type { GraphReadCoverage } from './query-contracts.js';

export interface ReadGroupSummary {
  readonly key: string;
  readonly count: number;
}

/** Convert accumulated partial/truncation reasons into the shared coverage shape. */
export function coverageFromReasons(reasons: ReadonlySet<string>): GraphReadCoverage {
  const values = [...reasons].sort(compareCodePointStrings);
  return {
    complete: values.length === 0,
    truncated: values.some((reason) => reason.endsWith('-cap')),
    reasons: values,
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
