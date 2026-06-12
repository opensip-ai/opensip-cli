/**
 * namespace-claims — the ADR-0043 unclaimed-namespace report.
 *
 * The composer deliberately tolerates unclaimed top-level keys (the
 * uninstalled-tool forward-compat contract, `composer.ts` rule 2) — but it
 * tolerates them SILENTLY, which is the live typo hole: `fitnes:` validates
 * cleanly and the user's config just never applies. This pure analyzer makes
 * the tolerance observable: it names each unclaimed namespace and suggests
 * the nearest claimed one when a typo is plausible. The CLI emits the warning
 * (config stays log-free); rejection policy (a LOADED tool with an undeclared
 * namespace) also lives at the caller, which knows the loaded-tool set.
 */

import type { ToolConfigDeclaration } from './declaration.js';

/** One unclaimed top-level namespace, with a did-you-mean when one is close. */
export interface UnclaimedNamespace {
  readonly namespace: string;
  /** The nearest claimed namespace within edit distance ≤ 2, when any. */
  readonly suggestion?: string;
}

/** The ADR-0043 claim report for one validated document. */
export interface NamespaceClaimReport {
  readonly unclaimed: readonly UnclaimedNamespace[];
}

/**
 * Levenshtein distance, bounded: returns early with `max + 1` when the
 * difference cannot be ≤ `max`. Small inputs (config keys), no dependency.
 */
function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, curr[j]);
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

const SUGGESTION_MAX_DISTANCE = 2;

/**
 * Report the document's top-level keys that no declaration claims. Pure: no
 * IO, no logging — the caller decides warn-vs-reject per key (ADR-0043).
 */
export function analyzeNamespaceClaims(
  declarations: readonly ToolConfigDeclaration[],
  document: unknown,
): NamespaceClaimReport {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { unclaimed: [] };
  }
  const claimed = new Set(declarations.map((d) => d.namespace));
  const unclaimed: UnclaimedNamespace[] = [];
  for (const key of Object.keys(document)) {
    if (claimed.has(key)) continue;
    let suggestion: string | undefined;
    let best = SUGGESTION_MAX_DISTANCE + 1;
    for (const candidate of claimed) {
      const d = boundedEditDistance(key, candidate, SUGGESTION_MAX_DISTANCE);
      if (d < best) {
        best = d;
        suggestion = candidate;
      }
    }
    unclaimed.push({ namespace: key, ...(suggestion === undefined ? {} : { suggestion }) });
  }
  return { unclaimed };
}
