/**
 * Substring-with-character-skip fuzzy match for the persistent search
 * input and View 7. Pure algorithm emitted as a JS string.
 *
 * Algorithm: each character of the query must appear in the candidate
 * in order, but not necessarily contiguously. Score is built from:
 *   - prefix match (start at index 0): +50
 *   - exact-case bonus per matched char: +1
 *   - contiguous-run bonus (matched-after-matched): +2 per
 *   - shorter candidate preferred: -length * 0.01
 * Returns top matches sorted by score desc, score >= 0.
 */

export function dashboardSearchJs(): string {
  return String.raw`
function fuzzyMatch(query, names) {
  const q = (query || '').trim();
  if (q.length === 0) return [];
  const qLower = q.toLowerCase();
  const out = [];
  for (const name of names) {
    const score = fuzzyScore(qLower, q, name);
    if (score < 0) continue;
    out.push({ name, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function fuzzyScore(qLower, q, name) {
  if (typeof name !== 'string' || name.length === 0) return -1;
  const nameLower = name.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -2;
  for (let i = 0; i < name.length && qi < qLower.length; i++) {
    if (nameLower[i] === qLower[qi]) {
      // Exact-case bonus.
      if (name[i] === q[qi]) score += 1;
      // Contiguous-run bonus.
      if (i === lastMatchIdx + 1) score += 2;
      // Prefix bonus when matching the very first char at index 0.
      if (i === 0 && qi === 0) score += 50;
      lastMatchIdx = i;
      qi++;
    }
  }
  if (qi < qLower.length) return -1;
  // Shorter is better.
  score -= name.length * 0.01;
  return score;
}
`;
}
