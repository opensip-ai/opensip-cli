/**
 * Substring-with-character-skip fuzzy match for the persistent search
 * input and the Visualization node search.
 *
 * Algorithm: each character of the query must appear in the candidate
 * in order, but not necessarily contiguously. Score is built from:
 *   - prefix match (start at index 0): +50
 *   - exact-case bonus per matched char: +1
 *   - contiguous-run bonus (matched-after-matched): +2 per
 *   - shorter candidate preferred: -length * 0.01
 * Returns top matches sorted by score desc, score >= 0.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

/** One scored fuzzy-match result. */
export interface FuzzyMatch {
  name: string;
  score: number;
}

export function fuzzyMatch(query: string, names: readonly string[]): FuzzyMatch[] {
  const q = (query || '').trim();
  if (q.length === 0) return [];
  const qLower = q.toLowerCase();
  const out: FuzzyMatch[] = [];
  for (const name of names) {
    const score = fuzzyScore(qLower, q, name);
    if (score < 0) continue;
    out.push({ name, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Bonus for a single matched character at candidate index `i` / query index `qi`:
 * exact-case (+1), contiguous-run after the previous match (+2), and prefix-at-start
 * (+50). Extracted from the scan loop to keep `fuzzyScore` within complexity budget.
 */
function matchBonus(name: string, q: string, i: number, qi: number, lastMatchIdx: number): number {
  let bonus = 0;
  if (name[i] === q[qi]) bonus += 1; // exact-case
  if (i === lastMatchIdx + 1) bonus += 2; // contiguous run
  if (i === 0 && qi === 0) bonus += 50; // prefix at start
  return bonus;
}

export function fuzzyScore(qLower: string, q: string, name: string): number {
  if (typeof name !== 'string' || name.length === 0) return -1;
  const nameLower = name.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -2;
  for (let i = 0; i < name.length && qi < qLower.length; i++) {
    if (nameLower[i] === qLower[qi]) {
      score += matchBonus(name, q, i, qi, lastMatchIdx);
      lastMatchIdx = i;
      qi++;
    }
  }
  if (qi < qLower.length) return -1;
  // Shorter is better.
  score -= name.length * 0.01;
  return score;
}
