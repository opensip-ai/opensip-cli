/**
 * Shared resolver helpers usable by any GraphLanguageAdapter.
 *
 * These tiny utilities (`appendEdge`) used to live duplicated under
 * each lang-* adapter. The duplicated-function-body rule flagged the
 * duplication, which is correct — the body really is identical and
 * the rule has no false-positive heuristic that would skip it.
 *
 * Putting these in lang-adapter/ keeps them on the contract layer:
 * adapters already import types from `./types.js`, so importing one
 * more helper is structurally consistent. The layering rules forbid
 * lang-* adapters from importing each other but say nothing about
 * lang-adapter/.
 */

import type { CallEdge } from '../types.js';

/**
 * Append a CallEdge to the per-owner edge list, creating the list on
 * first append. Trivial — but small functions deserve a single home.
 */
export function appendEdge(
  edgesByOwner: Map<string, CallEdge[]>,
  ownerHash: string,
  edge: CallEdge,
): void {
  const existing = edgesByOwner.get(ownerHash);
  if (existing) existing.push(edge);
  else edgesByOwner.set(ownerHash, [edge]);
}
