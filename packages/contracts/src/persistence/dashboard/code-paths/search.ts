/**
 * Substring-with-character-skip fuzzy match for the persistent search input
 * and View 7. Pure algorithm emitted as a JS string.
 *
 * Phase P0 stub: returns []. Phase P8 implements the matcher with scoring
 * (prefix bonus, exact-case bonus, contiguous-run bonus).
 */

export function dashboardSearchJs(): string {
  return String.raw`
function fuzzyMatch(query, names) {
  // Phase P8 implements scoring; Phase P0 returns no matches.
  return [];
}
`;
}
