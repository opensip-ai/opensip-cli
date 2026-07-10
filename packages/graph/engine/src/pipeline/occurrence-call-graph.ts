/**
 * Canonical occurrence-resolved call graph (one resolveCallee pass).
 *
 * Consumed by SCC features and public audit call views. Not exported from
 * `@opensip-cli/graph/read` — graph-internal only.
 */

import { compareCodePointStrings, sortedStringAdjacency } from '../code-point-order.js';
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
  /** Persisted call rows omitted because their runtime shape was invalid. */
  readonly malformedCalls: number;
}

const occurrenceGraphCache = new WeakMap<Indexes, OccurrenceCallGraph>();

/** One immutable occurrence graph per generation index object. */
export function occurrenceCallGraphFor(indexes: Indexes): OccurrenceCallGraph {
  const cached = occurrenceGraphCache.get(indexes);
  if (cached !== undefined) return cached;
  const graph = buildOccurrenceCallGraph(indexes);
  occurrenceGraphCache.set(indexes, graph);
  return graph;
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
  const malformedCalls = { value: 0 };

  const occurrences = [...indexes.occurrencesByHash.values()]
    .flat()
    .sort((left, right) => compareCodePointStrings(occId(left), occId(right)));
  for (const occurrence of occurrences) {
    addOccurrence(occurrence, indexes, {
      byOccId,
      edges,
      unresolved,
      forwardSets,
      reverseSets,
      malformedCalls,
    });
  }

  edges.sort(compareResolvedEdges);
  unresolved.sort(compareUnresolvedCalls);

  return {
    nodes: [...byOccId.keys()].sort(compareCodePointStrings),
    byOccId,
    edges,
    forward: sortedStringAdjacency(forwardSets),
    reverse: sortedStringAdjacency(reverseSets),
    unresolved,
    malformedCalls: malformedCalls.value,
  };
}

interface OccurrenceGraphAccumulator {
  readonly byOccId: Map<string, FunctionOccurrence>;
  readonly edges: ResolvedOccurrenceEdge[];
  readonly unresolved: UnresolvedOccurrenceCall[];
  readonly forwardSets: Map<string, Set<string>>;
  readonly reverseSets: Map<string, Set<string>>;
  readonly malformedCalls: { value: number };
}

function addOccurrence(
  owner: FunctionOccurrence,
  indexes: Indexes,
  output: OccurrenceGraphAccumulator,
): void {
  const ownerId = occId(owner);
  output.byOccId.set(ownerId, owner);
  ensureNode(ownerId, output);
  if (!Array.isArray(owner.calls)) {
    output.malformedCalls.value++;
    return;
  }
  for (const call of owner.calls as readonly unknown[]) {
    if (!isSafeCallEdge(call)) {
      output.malformedCalls.value++;
      continue;
    }
    addCall(owner, ownerId, call, indexes, output);
  }
}

const CALL_RESOLUTIONS: ReadonlySet<unknown> = new Set([
  'static',
  'method-dispatch',
  'jsx',
  'constructor',
  'unknown',
  'dynamic-string',
  'syntactic',
  'semantic',
]);
const CALL_CONFIDENCES: ReadonlySet<unknown> = new Set(['high', 'medium', 'low']);
const MAX_CALL_TARGETS = 10_000;
const MAX_TARGET_HASH_LENGTH = 128;

function isSafeCallEdge(value: unknown): value is CallEdge {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const edge = value as Record<string, unknown>;
  return (
    Array.isArray(edge.to) &&
    edge.to.length <= MAX_CALL_TARGETS &&
    edge.to.every(
      (target) =>
        typeof target === 'string' &&
        target.length > 0 &&
        target.length <= MAX_TARGET_HASH_LENGTH &&
        !/\p{Cc}/u.test(target),
    ) &&
    Number.isSafeInteger(edge.line) &&
    (edge.line as number) >= 1 &&
    Number.isSafeInteger(edge.column) &&
    (edge.column as number) >= 0 &&
    CALL_RESOLUTIONS.has(edge.resolution) &&
    CALL_CONFIDENCES.has(edge.confidence) &&
    (edge.crossShard === undefined || typeof edge.crossShard === 'boolean')
  );
}

function addCall(
  owner: FunctionOccurrence,
  ownerId: string,
  call: CallEdge,
  indexes: Indexes,
  output: OccurrenceGraphAccumulator,
): void {
  const unresolvedTargets: string[] = [];
  for (const targetHash of [...call.to].sort(compareCodePointStrings)) {
    const target = resolveCallee(targetHash, owner, indexes);
    if (target === undefined) {
      unresolvedTargets.push(targetHash);
      continue;
    }
    const targetId = occId(target);
    output.byOccId.set(targetId, target);
    ensureNode(targetId, output);
    output.edges.push({
      fromOccId: ownerId,
      toOccId: targetId,
      owner,
      target,
      callSite: { line: call.line, column: call.column },
      resolution: call.resolution,
      confidence: call.confidence,
      crossShard: call.crossShard === true,
      sourceEdge: call,
    });
    output.forwardSets.get(ownerId)?.add(targetId);
    output.reverseSets.get(targetId)?.add(ownerId);
  }
  if (call.to.length === 0 || unresolvedTargets.length > 0) {
    output.unresolved.push({
      ownerOccId: ownerId,
      owner,
      callSite: { line: call.line, column: call.column },
      resolution: call.resolution,
      confidence: call.confidence,
      targetHashes: unresolvedTargets,
    });
  }
}

function ensureNode(id: string, output: OccurrenceGraphAccumulator): void {
  if (!output.forwardSets.has(id)) output.forwardSets.set(id, new Set());
  if (!output.reverseSets.has(id)) output.reverseSets.set(id, new Set());
}

function compareResolvedEdges(left: ResolvedOccurrenceEdge, right: ResolvedOccurrenceEdge): number {
  return compareCodePointStrings(edgeKey(left), edgeKey(right));
}

function edgeKey(edge: ResolvedOccurrenceEdge): string {
  return [
    edge.fromOccId,
    edge.toOccId,
    String(edge.callSite.line).padStart(10, '0'),
    String(edge.callSite.column).padStart(10, '0'),
    edge.resolution,
    edge.confidence,
  ].join('\u0000');
}

function compareUnresolvedCalls(
  left: UnresolvedOccurrenceCall,
  right: UnresolvedOccurrenceCall,
): number {
  return compareCodePointStrings(unresolvedKey(left), unresolvedKey(right));
}

function unresolvedKey(call: UnresolvedOccurrenceCall): string {
  return [
    call.ownerOccId,
    String(call.callSite.line).padStart(10, '0'),
    String(call.callSite.column).padStart(10, '0'),
    ...call.targetHashes,
  ].join('\u0000');
}
