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

// ── Edge-text truncation constants ────────────────────────────────
//
// `CallEdge.text` is contracted at "≤ 80 chars" (`types.ts:65-66`).
// The producer-side promise was previously enforced by four files
// each carrying their own magic numbers (80/77/70/67) — the 2026-05-23
// audit (N-2) pulled them here so the contract literally lives next
// to the helper that creates the edges.

/** Maximum length of a `CallEdge.text` field. Per types.ts contract. */
export const CALL_EDGE_TEXT_MAX = 80;

/** Ellipsis appended to truncated edge text. */
const CALL_EDGE_TRUNCATION_SUFFIX = '...';

/** Maximum payload length when truncating: leaves room for the ellipsis. */
const CALL_EDGE_TEXT_PAYLOAD_MAX = CALL_EDGE_TEXT_MAX - CALL_EDGE_TRUNCATION_SUFFIX.length;

/** Prefix prepended to creation-edge text (`[creates] `). */
export const CREATION_EDGE_PREFIX = '[creates] ';

/**
 * Maximum length of the inner source-text slice that gets prefixed
 * with `[creates] ` to form a creation edge. The total edge text
 * after prefixing is bounded by `CALL_EDGE_TEXT_MAX`.
 */
export const CREATION_EDGE_TEXT_MAX = CALL_EDGE_TEXT_MAX - CREATION_EDGE_PREFIX.length;

const CREATION_EDGE_TEXT_PAYLOAD_MAX = CREATION_EDGE_TEXT_MAX - CALL_EDGE_TRUNCATION_SUFFIX.length;

/**
 * Truncate raw call-site source text to fit within `CallEdge.text`'s
 * 80-char contract. Long strings get sliced and ellipsized; short
 * strings pass through unchanged. Single source of truth for the
 * truncation contract — adapters call this instead of inlining the
 * length math.
 */
export function truncateForCallEdge(text: string): string {
  return text.length > CALL_EDGE_TEXT_MAX
    ? `${text.slice(0, CALL_EDGE_TEXT_PAYLOAD_MAX)}${CALL_EDGE_TRUNCATION_SUFFIX}`
    : text;
}

/**
 * Truncate the inner source text used inside a creation edge so the
 * `[creates] <text>` total stays within `CallEdge.text`'s 80-char
 * contract. The prefix is added by `pushCreationEdge`.
 */
function truncateForCreationEdge(text: string): string {
  return text.length > CREATION_EDGE_TEXT_MAX
    ? `${text.slice(0, CREATION_EDGE_TEXT_PAYLOAD_MAX)}${CALL_EDGE_TRUNCATION_SUFFIX}`
    : text;
}

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

/**
 * The two output accumulators a resolver threads through edge emission:
 * the per-owner edge map and the running confidence stats. Grouping them
 * names the "resolution output" a resolver allocates once per pass and
 * keeps the edge-push helpers (and the adapter `pushCallEdge` functions)
 * under the wide-function parameter budget.
 */
export interface EdgeSink {
  /** Per-owner-hash edge list, appended via {@link appendEdge}. */
  readonly edgesByOwner: Map<string, CallEdge[]>;
  /** Running per-confidence counters, bumped as edges are appended. */
  readonly stats: MutableStats;
}

/** Constructs a fresh {@link MutableStats} accumulator for edge resolver bookkeeping. */
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
 * Parser-agnostic: the caller resolves the call site's {@link EdgePosition}
 * (the only thing the helper needs from the adapter's node/file pair) and
 * passes it in, so this helper never touches a parser-specific node shape.
 * Bumps `totalCallSites` and `resolvedHigh` on the sink's stats.
 */
export function pushCreationEdge(
  pos: EdgePosition,
  ownerHash: string,
  childHash: string,
  sink: EdgeSink,
): void {
  const truncated = truncateForCreationEdge(pos.text);
  const edge: CallEdge = {
    to: [childHash],
    line: pos.line,
    column: pos.column,
    resolution: 'static',
    confidence: 'high',
    text: `${CREATION_EDGE_PREFIX}${truncated}`,
    discarded: false,
  };
  appendEdge(sink.edgesByOwner, ownerHash, edge);
  sink.stats.totalCallSites++;
  sink.stats.resolvedHigh++;
}
