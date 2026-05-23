/**
 * Shared resolver helpers usable by any GraphLanguageAdapter.
 *
 * These tiny utilities used to live duplicated under each lang-*
 * adapter (`appendEdge`, `pushCreationEdge`, the `MutableStats`
 * counter shape). The duplicated-function-body rule flagged the
 * duplication, which is correct — the bodies really are identical
 * and the rule has no false-positive heuristic that would skip them.
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

/**
 * Per-confidence stat counters mutated as edges are appended. Same
 * shape every adapter resolver assembles inline; consolidated here
 * with an `apply(edge)` method that classifies and bumps the right
 * counter so resolvers don't repeat the if-ladder.
 *
 * Use {@link createMutableStats} for a fresh zeroed instance.
 */
export interface MutableStats {
  totalCallSites: number;
  resolvedHigh: number;
  resolvedMedium: number;
  resolvedLow: number;
  unresolved: number;
  /**
   * Classify `edge` by its `to.length` and `confidence` and bump the
   * matching counter. Does NOT touch `totalCallSites` — call sites
   * include unresolved-by-shape decisions that don't always produce
   * an edge, so call-site counting stays the resolver's job.
   */
  apply(edge: CallEdge): void;
}

export function createMutableStats(): MutableStats {
  const stats = {
    totalCallSites: 0,
    resolvedHigh: 0,
    resolvedMedium: 0,
    resolvedLow: 0,
    unresolved: 0,
    apply(edge: CallEdge): void {
      if (edge.to.length === 0) {
        this.unresolved++;
        return;
      }
      if (edge.confidence === 'high') this.resolvedHigh++;
      else if (edge.confidence === 'medium') this.resolvedMedium++;
      else this.resolvedLow++;
    },
  };
  return stats;
}

/**
 * Position info every adapter must derive from its node/file pair to
 * build a CallEdge. Adapters supply this via the `position` callback
 * to {@link pushCreationEdge}, keeping the helper agnostic to the
 * underlying parser shape (TS Node + SourceFile, tree-sitter Node +
 * source string, etc.).
 */
export interface EdgePosition {
  /** 1-based line number. */
  readonly line: number;
  /** 0-based column. */
  readonly column: number;
  /** Source text of the call site, untruncated. */
  readonly text: string;
}

/**
 * Append a synthetic creation edge — the parent owner contains an
 * inline-callable child, so its enclosing scope's reachability flows
 * to the child unconditionally. Static, high-confidence by
 * construction.
 *
 * Generic over the adapter's node and file shapes; the `position`
 * callback resolves the line/column/text without forcing the helper
 * to know how the adapter parses code. Bumps `totalCallSites` and
 * `resolvedHigh` on the supplied stats.
 */
export function pushCreationEdge<NodeRef, FileRef>(
  node: NodeRef,
  file: FileRef,
  ownerHash: string,
  childHash: string,
  edgesByOwner: Map<string, CallEdge[]>,
  stats: MutableStats,
  position: (node: NodeRef, file: FileRef) => EdgePosition,
): void {
  const pos = position(node, file);
  const truncated = pos.text.length > 70 ? `${pos.text.slice(0, 67)}...` : pos.text;
  const edge: CallEdge = {
    to: [childHash],
    line: pos.line,
    column: pos.column,
    resolution: 'static',
    confidence: 'high',
    text: `[creates] ${truncated}`,
    discarded: false,
  };
  appendEdge(edgesByOwner, ownerHash, edge);
  stats.totalCallSites++;
  stats.resolvedHigh++;
}
