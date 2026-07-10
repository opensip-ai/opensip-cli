/**
 * Canonical occurrence-resolved call graph (one resolveCallee pass).
 *
 * Consumed by SCC features and public audit call views. Not exported from
 * `@opensip-cli/graph/read` — graph-internal only.
 */

import { occId, resolveCallee } from '../resolve-callee.js';

import type { CallEdge, FunctionOccurrence, Indexes } from '../types.js';

/** One resolved occurrence→occurrence edge fact (polymorphic targets stay distinct). */
export interface ResolvedOccurrenceEdge {
  readonly fromOccId: string;
  readonly toOccId: string;
  readonly owner: FunctionOccurrence;
  readonly target: FunctionOccurrence;
  readonly callSite: { readonly line: number; readonly column: number };
  readonly resolution: CallEdge['resolution'];
  readonly confidence: CallEdge['confidence'];
  readonly crossShard: boolean;
  readonly sourceEdge: CallEdge;
}

/** Unresolved call-site fact (never invented as an edge). */
export interface UnresolvedOccurrenceCall {
  readonly ownerOccId: string;
  readonly owner: FunctionOccurrence;
  readonly callSite: { readonly line: number; readonly column: number };
  readonly resolution: CallEdge['resolution'];
  readonly confidence: CallEdge['confidence'];
  readonly targetHashes: readonly string[];
}

export interface OccurrenceCallGraph {
  /** Every occurrence id. */
  readonly nodes: readonly string[];
  readonly byOccId: ReadonlyMap<string, FunctionOccurrence>;
  /** Canonical resolved edge stream (may include multi-edges for polymorphic targets). */
  readonly edges: readonly ResolvedOccurrenceEdge[];
  /** Deduped forward adjacency for reachability. */
  readonly forward: ReadonlyMap<string, readonly string[]>;
  /** Reverse adjacency derived from the same edge stream. */
  readonly reverse: ReadonlyMap<string, readonly string[]>;
  readonly unresolved: readonly UnresolvedOccurrenceCall[];
}

/**
 * Build the occurrence-level call graph with one resolveCallee pass.
 * Polymorphic targets remain distinct edge facts; adjacency neighbors are deduped.
 */
export function buildOccurrenceCallGraph(indexes: Indexes): OccurrenceCallGraph {
  const byOccId = new Map<string, FunctionOccurrence>();
  const edges: ResolvedOccurrenceEdge[] = [];
  const unresolved: UnresolvedOccurrenceCall[] = [];
  const forwardSets = new Map<string, Set<string>>();
  const reverseSets = new Map<string, Set<string>>();

  for (const occs of indexes.occurrencesByHash.values()) {
    for (const occ of occs) {
      const fromId = occId(occ);
      byOccId.set(fromId, occ);
      if (!forwardSets.has(fromId)) forwardSets.set(fromId, new Set());
      if (!reverseSets.has(fromId)) reverseSets.set(fromId, new Set());

      for (const callEdge of occ.calls) {
        if (callEdge.to.length === 0) {
          unresolved.push({
            ownerOccId: fromId,
            owner: occ,
            callSite: { line: callEdge.line, column: callEdge.column },
            resolution: callEdge.resolution,
            confidence: callEdge.confidence,
            targetHashes: [],
          });
          continue;
        }
        let anyResolved = false;
        for (const target of callEdge.to) {
          const callee = resolveCallee(target, occ, indexes);
          if (!callee) continue;
          anyResolved = true;
          const toId = occId(callee);
          byOccId.set(toId, callee);
          edges.push({
            fromOccId: fromId,
            toOccId: toId,
            owner: occ,
            target: callee,
            callSite: { line: callEdge.line, column: callEdge.column },
            resolution: callEdge.resolution,
            confidence: callEdge.confidence,
            crossShard: callEdge.crossShard === true,
            sourceEdge: callEdge,
          });
          forwardSets.get(fromId)?.add(toId);
          if (!reverseSets.has(toId)) reverseSets.set(toId, new Set());
          reverseSets.get(toId)?.add(fromId);
          if (!forwardSets.has(toId)) forwardSets.set(toId, new Set());
        }
        if (!anyResolved) {
          unresolved.push({
            ownerOccId: fromId,
            owner: occ,
            callSite: { line: callEdge.line, column: callEdge.column },
            resolution: callEdge.resolution,
            confidence: callEdge.confidence,
            targetHashes: callEdge.to,
          });
        }
      }
    }
  }

  const forward = new Map<string, readonly string[]>();
  for (const [k, set] of forwardSets) forward.set(k, [...set]);
  const reverse = new Map<string, readonly string[]>();
  for (const [k, set] of reverseSets) reverse.set(k, [...set]);

  return {
    nodes: [...byOccId.keys()],
    byOccId,
    edges,
    forward,
    reverse,
    unresolved,
  };
}
