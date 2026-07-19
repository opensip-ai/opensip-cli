/**
 * Deterministic, locale-independent string ordering for stable sorts.
 *
 * Exact semantics of the historical `compareCodePoint` in
 * `@opensip-cli/contracts` (which now re-exports this helper): JavaScript's
 * native UTF-16 relational comparison, so astral-plane characters order by
 * their surrogate pairs (an emoji sorts BEFORE U+FFFD, despite the larger
 * code point). One kernel implementation keeps detector orderings and
 * human-facing sorts identical across packages.
 */
export function compareByCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
