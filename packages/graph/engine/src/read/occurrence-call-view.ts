/** Public occurrence-precise / body-twin call views over the canonical graph. */

import { err, ok, type Result } from '@opensip-cli/core';

import { compareCodePointStrings, sortedStringAdjacency } from '../code-point-order.js';
import { occurrenceCallGraphFor } from '../pipeline/occurrence-call-graph.js';
import { occId } from '../resolve-callee.js';

import {
  toGraphSymbolRef,
  type CallEdgeEvidence,
  type GraphSourceFilter,
  type GraphSymbolRef,
} from './query-contracts.js';
import { matchesGraphSourceFilterWithRoles, type SourceRoleMatcher } from './source-filter.js';

import type { GraphReadError } from './types.js';
import type {
  OccurrenceCallGraph,
  ResolvedOccurrenceEdge,
  UnresolvedOccurrenceCall,
} from '../pipeline/occurrence-call-graph.js';
import type { Catalog, FunctionOccurrence, Indexes } from '../types.js';

// Plan 01: the `GRAPH` head was mapped by nothing, so every one of these resolved to
// UNKNOWN_FAILURE — fatal and operator-only — for conditions MCP consumers branch on.

/** Traversal, identity, and source-selection options for an occurrence call view. */
export interface OccurrenceCallViewQuery {
  readonly filter: GraphSourceFilter;
  readonly identity: 'occurrence' | 'body-twin-union';
  readonly startSymbolId?: string;
  readonly goalSymbolId?: string;
  readonly direction?: 'callers' | 'callees' | 'both';
  readonly depth?: number;
  readonly maxNodes?: number;
}

/** Bounded unresolved-call evidence attributed to its owning occurrence. */
export interface UnresolvedCallSummary {
  readonly ownerSymbolId: string;
  readonly resolution: string;
  readonly confidence: string;
  readonly callSite: {
    readonly filePath: string;
    readonly line: number;
    readonly column: number;
  };
  readonly targetHashes: readonly string[];
  readonly totalTargetHashes: number;
}

/** Occurrence-precise call topology with bounded evidence and coverage metadata. */
export interface OccurrenceCallView {
  readonly nodes: readonly GraphSymbolRef[];
  readonly edges: readonly CallEdgeEvidence[];
  readonly forward: ReadonlyMap<string, readonly string[]>;
  readonly reverse: ReadonlyMap<string, readonly string[]>;
  readonly members: ReadonlyMap<string, readonly GraphSymbolRef[]>;
  readonly totalMembership: number;
  readonly counts: {
    readonly includedOccurrences: number;
    readonly excludedOccurrences: number;
    readonly includedEdges: number;
    readonly excludedEdges: number;
    readonly countScope: 'visited';
  };
  readonly unresolved: readonly UnresolvedCallSummary[];
  readonly totalUnresolved: number;
  readonly unresolvedCounts: readonly {
    readonly resolution: string;
    readonly confidence: string;
    readonly count: number;
  }[];
  readonly unresolvedAttribution: 'owner-only';
  readonly coverage: {
    readonly complete: boolean;
    readonly truncated: boolean;
    readonly reasons: readonly string[];
  };
}

const MAX_UNRESOLVED = 50;
const DEFAULT_MAX_NODES = 2000;
const MAX_RESOLVED_EVIDENCE = 20_000;
const MAX_UNRESOLVED_TARGETS = 20;
const MAX_TARGET_HASH_LENGTH = 128;

interface CachedOccurrenceIndex {
  readonly graph: OccurrenceCallGraph;
  readonly outgoing: ReadonlyMap<string, readonly ResolvedOccurrenceEdge[]>;
  readonly incoming: ReadonlyMap<string, readonly ResolvedOccurrenceEdge[]>;
  readonly unresolvedByOwner: ReadonlyMap<string, readonly UnresolvedOccurrenceCall[]>;
  readonly occurrencesByBody: ReadonlyMap<string, readonly FunctionOccurrence[]>;
  readonly bodyKeys: readonly string[];
}

const occurrenceIndexCache = new WeakMap<Indexes, CachedOccurrenceIndex>();

function viewError(message: string): GraphReadError {
  return { code: 'query-invalid', operation: 'analysis', message };
}

/** Build an occurrence or body-twin-union call view from canonical read indexes. */
export function buildOccurrenceCallView(
  _catalog: Catalog,
  indexes: Indexes,
  query: OccurrenceCallViewQuery,
  matcher: SourceRoleMatcher,
): Result<OccurrenceCallView, GraphReadError> {
  try {
    return ok(new ViewCollector(cachedOccurrenceIndex(indexes), query, matcher).collect());
  } catch {
    return err(viewError('Failed to build occurrence call view'));
  }
}

class ViewCollector {
  private readonly identity: OccurrenceCallViewQuery['identity'];
  private readonly direction: NonNullable<OccurrenceCallViewQuery['direction']>;
  private readonly maxDepth: number;
  private readonly maxNodes: number;
  private readonly predicate = new Map<string, boolean>();
  private readonly included = new Map<string, FunctionOccurrence>();
  private readonly excluded = new Set<string>();
  private readonly groupOccurrences = new Map<string, readonly string[]>();
  private readonly memberRows = new Map<string, readonly GraphSymbolRef[]>();
  private readonly keptEdges = new Map<string, ResolvedOccurrenceEdge>();
  private readonly excludedEdges = new Set<string>();
  private readonly queued = new Set<string>();
  private readonly visited = new Set<string>();
  private readonly queue: { readonly key: string; readonly depth: number }[] = [];
  private hardTruncated = false;
  private depthTruncated = false;
  private evidenceTruncated = false;
  private malformedSymbols = 0;
  private duplicateSymbols = 0;
  private goalReached = false;

  constructor(
    private readonly index: CachedOccurrenceIndex,
    private readonly query: OccurrenceCallViewQuery,
    private readonly matcher: SourceRoleMatcher,
  ) {
    this.identity = query.identity;
    this.direction = query.direction ?? 'both';
    this.maxDepth = Math.min(Math.max(Math.trunc(query.depth ?? 5), 0), 5);
    this.maxNodes = Math.min(
      Math.max(Math.trunc(query.maxNodes ?? DEFAULT_MAX_NODES), 1),
      DEFAULT_MAX_NODES,
    );
  }

  collect(): OccurrenceCallView {
    for (const key of this.seedKeys()) {
      if (this.predicate.size >= this.maxNodes) {
        this.hardTruncated = true;
        break;
      }
      this.enqueueGroup(key, 0);
      if (this.goalReached) break;
    }
    let queueIndex = 0;
    while (queueIndex < this.queue.length && !this.goalReached) {
      const current = this.queue[queueIndex++];
      if (current === undefined || this.visited.has(current.key)) continue;
      this.visited.add(current.key);
      this.visitGroup(current.key, current.depth);
    }
    return this.toView();
  }

  private seedKeys(): readonly string[] {
    if (this.query.startSymbolId !== undefined) {
      const occurrence = this.index.graph.byOccId.get(this.query.startSymbolId);
      if (occurrence === undefined) return [];
      return [this.keyForOccurrence(occurrence)];
    }
    if (this.identity === 'occurrence') return this.index.graph.nodes;
    return this.index.bodyKeys;
  }

  private enqueueGroup(key: string, depth: number): boolean {
    if (this.queued.has(key) || this.visited.has(key)) return false;
    const members = this.evaluateGroup(key);
    if (members.length === 0) return false;
    this.queued.add(key);
    this.queue.push({ key, depth });
    const reached = key === this.goalKey();
    if (reached) this.goalReached = true;
    return reached;
  }

  private visitGroup(key: string, depth: number): void {
    const memberIds = this.groupOccurrences.get(key) ?? [];
    for (const memberId of memberIds) {
      for (const edge of this.edgesFor(memberId)) {
        this.inspectEdge(edge, memberId, depth, depth < this.maxDepth);
      }
    }
  }

  private inspectEdge(
    edge: ResolvedOccurrenceEdge,
    currentId: string,
    depth: number,
    allowDiscovery: boolean,
  ): void {
    const otherId = edge.fromOccId === currentId ? edge.toOccId : edge.fromOccId;
    const other = this.index.graph.byOccId.get(otherId);
    if (other === undefined) {
      this.recordExcludedEdge(edge);
      return;
    }
    const otherKey = this.keyForOccurrence(other);
    const known = this.queued.has(otherKey) || this.visited.has(otherKey);
    // Once the deterministic goal boundary is reached, retain additional
    // evidence between already-discovered groups but do not examine/enqueue
    // siblings that boundedBfs would never visit.
    if (this.goalReached && !known) return;
    if (!this.matches(otherId, other)) {
      this.recordExcludedEdge(edge);
      return;
    }
    if (!allowDiscovery && !known) {
      this.depthTruncated = true;
      return;
    }
    if (!known) this.enqueueGroup(otherKey, depth + 1);
    if (this.groupOccurrences.has(otherKey)) {
      const key = resolvedEdgeKey(edge);
      if (!this.keptEdges.has(key)) {
        if (this.keptEdges.size >= MAX_RESOLVED_EVIDENCE) {
          this.evidenceTruncated = true;
          return;
        }
        this.keptEdges.set(key, edge);
      }
    }
  }

  private evaluateGroup(key: string): readonly string[] {
    const cached = this.groupOccurrences.get(key);
    if (cached !== undefined) return cached;
    const occurrences = this.occurrencesForKey(key);
    const includedIds: string[] = [];
    const rows: GraphSymbolRef[] = [];
    const seenIds = new Set<string>();
    for (const occurrence of occurrences) {
      const id = occId(occurrence);
      if (seenIds.has(id)) {
        this.duplicateSymbols++;
        continue;
      }
      seenIds.add(id);
      if (!this.predicate.has(id) && this.predicate.size >= this.maxNodes) {
        this.hardTruncated = true;
        break;
      }
      if (!this.matches(id, occurrence)) {
        this.markExcludedMemberEdges(id);
        continue;
      }
      includedIds.push(id);
      this.included.set(id, occurrence);
      const row = toGraphSymbolRef(occurrence);
      if (row === undefined) this.malformedSymbols++;
      else rows.push(row);
    }
    includedIds.sort(compareCodePointStrings);
    rows.sort((left, right) => compareCodePointStrings(left.symbolId, right.symbolId));
    this.groupOccurrences.set(key, includedIds);
    this.memberRows.set(key, rows);
    return includedIds;
  }

  private matches(id: string, occurrence: FunctionOccurrence): boolean {
    const cached = this.predicate.get(id);
    if (cached !== undefined) return cached;
    if (this.predicate.size >= this.maxNodes) {
      this.hardTruncated = true;
      return false;
    }
    const matches = matchesGraphSourceFilterWithRoles(occurrence, this.query.filter, this.matcher);
    this.predicate.set(id, matches);
    if (!matches) this.excluded.add(id);
    return matches;
  }

  private markExcludedMemberEdges(id: string): void {
    for (const edge of this.edgesFor(id)) this.recordExcludedEdge(edge);
  }

  private recordExcludedEdge(edge: ResolvedOccurrenceEdge): void {
    const key = resolvedEdgeKey(edge);
    if (this.excludedEdges.has(key)) return;
    if (this.excludedEdges.size >= MAX_RESOLVED_EVIDENCE) {
      this.evidenceTruncated = true;
      return;
    }
    this.excludedEdges.add(key);
  }

  private edgesFor(id: string): readonly ResolvedOccurrenceEdge[] {
    if (this.direction === 'callers') return this.index.incoming.get(id) ?? [];
    if (this.direction === 'callees') return this.index.outgoing.get(id) ?? [];
    return mergeEdges(this.index.outgoing.get(id) ?? [], this.index.incoming.get(id) ?? []);
  }

  private occurrencesForKey(key: string): readonly FunctionOccurrence[] {
    if (this.identity === 'body-twin-union') return this.index.occurrencesByBody.get(key) ?? [];
    const occurrence = this.index.graph.byOccId.get(key);
    return occurrence === undefined ? [] : [occurrence];
  }

  private keyForOccurrence(occurrence: FunctionOccurrence): string {
    return this.identity === 'occurrence' ? occId(occurrence) : occurrence.bodyHash;
  }

  private goalKey(): string | undefined {
    if (this.query.goalSymbolId === undefined) return undefined;
    const goal = this.index.graph.byOccId.get(this.query.goalSymbolId);
    return goal === undefined ? undefined : this.keyForOccurrence(goal);
  }

  private toView(): OccurrenceCallView {
    const evidence = [...this.keptEdges.values()].map(toEvidence).filter(isDefined);
    evidence.sort((left, right) => compareCodePointStrings(evidenceKey(left), evidenceKey(right)));
    const adjacency = buildViewAdjacency(this.groupOccurrences.keys(), evidence, this.identity);
    const unresolved = this.summarizeVisitedUnresolved();
    const reverseLimitation =
      this.direction === 'callers' && this.index.graph.unresolved.length > 0;
    const reasons = [
      ...(this.hardTruncated ? ['walk-node-cap'] : []),
      ...(this.depthTruncated ? ['view-depth-cap'] : []),
      ...(this.evidenceTruncated ? ['resolved-evidence-cap'] : []),
      ...(unresolved.truncated ? ['unresolved-sample-cap'] : []),
      ...(unresolved.detailTruncated ? ['unresolved-detail-cap'] : []),
      ...(unresolved.detailSanitized ? ['malformed-unresolved-target-sanitized'] : []),
      ...(this.malformedSymbols > 0 || unresolved.malformedOwners > 0
        ? ['malformed-symbol-omitted']
        : []),
      ...(this.duplicateSymbols > 0 ? ['duplicate-symbol-omitted'] : []),
      ...(this.index.graph.malformedCalls > 0 ? ['malformed-call-edge-omitted'] : []),
      ...(reverseLimitation ? ['unresolved-reverse-attribution-unavailable'] : []),
    ];
    const nodes = [...this.memberRows.values()].flat();
    nodes.sort((left, right) => compareCodePointStrings(left.symbolId, right.symbolId));
    return {
      nodes,
      edges: evidence,
      forward: adjacency.forward,
      reverse: adjacency.reverse,
      members: sortedMembers(this.memberRows),
      totalMembership: this.included.size,
      counts: {
        includedOccurrences: this.included.size,
        excludedOccurrences: this.excluded.size,
        includedEdges: this.keptEdges.size,
        excludedEdges: this.excludedEdges.size,
        countScope: 'visited',
      },
      unresolved: unresolved.sample,
      totalUnresolved: unresolved.total,
      unresolvedCounts: unresolved.buckets,
      unresolvedAttribution: 'owner-only',
      coverage: {
        complete: reasons.length === 0,
        truncated:
          this.hardTruncated ||
          this.depthTruncated ||
          this.evidenceTruncated ||
          unresolved.truncated ||
          unresolved.detailTruncated,
        reasons,
      },
    };
  }

  private summarizeVisitedUnresolved(): {
    readonly sample: readonly UnresolvedCallSummary[];
    readonly total: number;
    readonly buckets: OccurrenceCallView['unresolvedCounts'];
    readonly truncated: boolean;
    readonly detailTruncated: boolean;
    readonly detailSanitized: boolean;
    readonly malformedOwners: number;
  } {
    const sample: UnresolvedCallSummary[] = [];
    const buckets = new Map<string, number>();
    let total = 0;
    let detailTruncated = false;
    let detailSanitized = false;
    let malformedOwners = 0;
    for (const ownerId of this.included.keys()) {
      for (const row of this.index.unresolvedByOwner.get(ownerId) ?? []) {
        const owner = toGraphSymbolRef(row.owner);
        if (owner?.symbolId !== ownerId) {
          malformedOwners++;
          continue;
        }
        total++;
        const bucket = JSON.stringify([row.resolution, row.confidence]);
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
        detailTruncated ||=
          row.targetHashes.length > MAX_UNRESOLVED_TARGETS ||
          row.targetHashes.some((hash) => hash.length > MAX_TARGET_HASH_LENGTH);
        detailSanitized ||= row.targetHashes.some((hash) => hasControl(hash));
        insertUnresolvedSample(sample, toUnresolvedSummary(row, owner));
      }
    }
    return {
      sample,
      total,
      buckets: [...buckets.entries()]
        .sort(([left], [right]) => compareCodePointStrings(left, right))
        .map(([key, count]) => {
          const [resolution = '', confidence = ''] = JSON.parse(key) as string[];
          return { resolution, confidence, count };
        }),
      truncated: total > MAX_UNRESOLVED,
      detailTruncated,
      detailSanitized,
      malformedOwners,
    };
  }
}

function cachedOccurrenceIndex(indexes: Indexes): CachedOccurrenceIndex {
  const cached = occurrenceIndexCache.get(indexes);
  if (cached !== undefined) return cached;
  const graph = occurrenceCallGraphFor(indexes);
  const outgoing = bucketEdges(graph.edges, (edge) => edge.fromOccId);
  const incoming = bucketEdges(graph.edges, (edge) => edge.toOccId);
  const unresolvedByOwner = bucketUnresolved(graph.unresolved);
  const occurrencesByBody = new Map<string, readonly FunctionOccurrence[]>();
  for (const [bodyHash, occurrences] of indexes.occurrencesByHash) {
    occurrencesByBody.set(
      bodyHash,
      [...occurrences].sort((left, right) => compareCodePointStrings(occId(left), occId(right))),
    );
  }
  const value = {
    graph,
    outgoing,
    incoming,
    unresolvedByOwner,
    occurrencesByBody,
    bodyKeys: [...occurrencesByBody.keys()].sort(compareCodePointStrings),
  };
  occurrenceIndexCache.set(indexes, value);
  return value;
}

function bucketEdges(
  edges: readonly ResolvedOccurrenceEdge[],
  keyOf: (edge: ResolvedOccurrenceEdge) => string,
): ReadonlyMap<string, readonly ResolvedOccurrenceEdge[]> {
  const buckets = new Map<string, ResolvedOccurrenceEdge[]>();
  for (const edge of edges) {
    const key = keyOf(edge);
    const rows = buckets.get(key) ?? [];
    rows.push(edge);
    buckets.set(key, rows);
  }
  return buckets;
}

function bucketUnresolved(
  rows: readonly UnresolvedOccurrenceCall[],
): ReadonlyMap<string, readonly UnresolvedOccurrenceCall[]> {
  const buckets = new Map<string, UnresolvedOccurrenceCall[]>();
  for (const row of rows) {
    const values = buckets.get(row.ownerOccId) ?? [];
    values.push(row);
    buckets.set(row.ownerOccId, values);
  }
  return buckets;
}

function mergeEdges(
  first: readonly ResolvedOccurrenceEdge[],
  second: readonly ResolvedOccurrenceEdge[],
): readonly ResolvedOccurrenceEdge[] {
  const edges = new Map<string, ResolvedOccurrenceEdge>();
  for (const edge of [...first, ...second]) edges.set(resolvedEdgeKey(edge), edge);
  return [...edges.values()];
}

function toEvidence(edge: ResolvedOccurrenceEdge): CallEdgeEvidence | undefined {
  const from = toGraphSymbolRef(edge.owner);
  const to = toGraphSymbolRef(edge.target);
  if (from === undefined || to === undefined) return undefined;
  const source = {
    file: edge.owner.filePath,
    line: edge.callSite.line,
    column: edge.callSite.column,
  };
  return {
    kind: 'call',
    from,
    to,
    source,
    resolution: edge.resolution,
    confidence: edge.confidence,
    crossShard: edge.crossShard,
  };
}

function buildViewAdjacency(
  keys: Iterable<string>,
  evidence: readonly CallEdgeEvidence[],
  identity: OccurrenceCallViewQuery['identity'],
): {
  readonly forward: ReadonlyMap<string, readonly string[]>;
  readonly reverse: ReadonlyMap<string, readonly string[]>;
} {
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  for (const key of keys) {
    forward.set(key, new Set());
    reverse.set(key, new Set());
  }
  for (const edge of evidence) {
    const from = identity === 'occurrence' ? edge.from.symbolId : edge.from.bodyHash;
    const to = identity === 'occurrence' ? edge.to.symbolId : edge.to.bodyHash;
    forward.get(from)?.add(to);
    reverse.get(to)?.add(from);
  }
  return {
    forward: sortedStringAdjacency(forward),
    reverse: sortedStringAdjacency(reverse),
  };
}

function sortedMembers(
  input: ReadonlyMap<string, readonly GraphSymbolRef[]>,
): ReadonlyMap<string, readonly GraphSymbolRef[]> {
  return new Map(
    [...input.entries()].sort(([left], [right]) => compareCodePointStrings(left, right)),
  );
}

function insertUnresolvedSample(sample: UnresolvedCallSummary[], row: UnresolvedCallSummary): void {
  sample.push(row);
  sample.sort((left, right) => compareCodePointStrings(unresolvedKey(left), unresolvedKey(right)));
  if (sample.length > MAX_UNRESOLVED) sample.pop();
}

function toUnresolvedSummary(
  row: UnresolvedOccurrenceCall,
  owner: GraphSymbolRef,
): UnresolvedCallSummary {
  return {
    ownerSymbolId: owner.symbolId,
    resolution: row.resolution,
    confidence: row.confidence,
    callSite: {
      filePath: owner.filePath,
      line: row.callSite.line,
      column: row.callSite.column,
    },
    targetHashes: row.targetHashes
      .slice(0, MAX_UNRESOLVED_TARGETS)
      .map((hash) => boundedTargetHash(hash)),
    totalTargetHashes: row.targetHashes.length,
  };
}

function boundedTargetHash(value: string): string {
  if (hasControl(value)) return '<invalid-target>';
  return value.slice(0, MAX_TARGET_HASH_LENGTH);
}

function hasControl(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function resolvedEdgeKey(edge: ResolvedOccurrenceEdge): string {
  return JSON.stringify([
    edge.fromOccId,
    edge.toOccId,
    edge.callSite.line,
    edge.callSite.column,
    edge.resolution,
    edge.confidence,
    edge.crossShard,
  ]);
}

function evidenceKey(edge: CallEdgeEvidence): string {
  return JSON.stringify([
    edge.from.symbolId,
    edge.to.symbolId,
    edge.source.line,
    edge.source.column,
    edge.resolution,
    edge.confidence,
    edge.crossShard,
  ]);
}

function unresolvedKey(row: UnresolvedCallSummary): string {
  return JSON.stringify([
    row.ownerSymbolId,
    row.callSite.line,
    row.callSite.column,
    ...row.targetHashes,
  ]);
}
