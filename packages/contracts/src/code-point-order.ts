/**
 * Deterministic UTF-16 code-unit string order for stable sorts.
 *
 * Shared across packages so body-hash detectors (yagni duplicate-body) and
 * human-facing orderings stay one implementation.
 */
export function compareCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Alias used by some call sites that prefer a longer name. */
export const compareCodePointStrings = compareCodePoint;
