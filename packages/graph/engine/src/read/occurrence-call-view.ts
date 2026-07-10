/**
 * Public occurrence-precise / body-twin call views over the canonical
 * occurrence call graph.
 */

import { err, ok, type Result } from '@opensip-cli/core';

import { buildOccurrenceCallGraph } from '../pipeline/occurrence-call-graph.js';
import { occId } from '../resolve-callee.js';

import { toGraphSymbolRef, type CallEdgeEvidence, type GraphSourceFilter } from './query-contracts.js';
import { matchesGraphSourceFilter } from './source-filter.js';

import type { GraphReadError } from './types.js';
import type { Catalog, FunctionOccurrence, Indexes } from '../types.js';
import type {
  OccurrenceCallGraph,
  ResolvedOccurrenceEdge,
} from '../pipeline/occurrence-call-graph.js';

export interface OccurrenceCallViewQuery {
  readonly filter: GraphSourceFilter;
  readonly identity: 'occurrence' | 'body-twin-union';
  readonly startSymbolId?: string;
}

export interface OccurrenceCallView {
  readonly nodes: readonly ReturnType<typeof toGraphSymbolRef>[];
  readonly edges: readonly CallEdgeEvidence[];
  readonly forward: ReadonlyMap<string, readonly string[]>;
  readonly reverse: ReadonlyMap<string, readonly string[]>;
  readonly totalMembership: number;
  readonly counts: {
    readonly includedOccurrences: number;
    readonly excludedOccurrences: number;
    readonly includedEdges: number;
    readonly excludedEdges: number;
    readonly countScope: 'visited';
  };
  readonly unresolved: readonly {
    readonly ownerSymbolId: string;
    readonly resolution: string;
    readonly confidence: string;
  }[];
  readonly coverage: {
    readonly complete: boolean;
    readonly truncated: boolean;
    readonly reasons: readonly string[];
  };
}

const MAX_UNRESOLVED = 50;

function viewError(message: string): GraphReadError {
  return { code: 'GRAPH.READ.OCCURRENCE_VIEW', operation: 'analysis', message };
}

/**
 * Build an occurrence- or twin-filtered call view.
 * Twin mode filters BOTH endpoints before grouping by body hash.
 */
export function buildOccurrenceCallView(
  _catalog: Catalog,
  indexes: Indexes,
  query: OccurrenceCallViewQuery,
): Result<OccurrenceCallView, GraphReadError> {
  try {
    const graph = buildOccurrenceCallGraph(indexes);
    const include = new Map<string, FunctionOccurrence>();
    let excludedOccurrences = 0;
    for (const [id, occ] of graph.byOccId) {
      if (matchesGraphSourceFilter(occ, query.filter)) {
        include.set(id, occ);
      } else {
        excludedOccurrences++;
      }
    }

    const keptEdges: ResolvedOccurrenceEdge[] = [];
    let excludedEdges = 0;
    for (const edge of graph.edges) {
      if (include.has(edge.fromOccId) && include.has(edge.toOccId)) {
        keptEdges.push(edge);
      } else {
        excludedEdges++;
      }
    }

    if (query.identity === 'body-twin-union') {
      return ok(projectTwinView(include, keptEdges, graph, excludedOccurrences, excludedEdges));
    }
    return ok(
      projectOccurrenceView(include, keptEdges, graph, excludedOccurrences, excludedEdges),
    );
  } catch {
    return err(viewError('Failed to build occurrence call view'));
  }
}

function projectOccurrenceView(
  include: ReadonlyMap<string, FunctionOccurrence>,
  edges: readonly ResolvedOccurrenceEdge[],
  graph: OccurrenceCallGraph,
  excludedOccurrences: number,
  excludedEdges: number,
): OccurrenceCallView {
  const nodes = [...include.values()]
    .map((occ) => toGraphSymbolRef(occ))
    .filter((n): n is NonNullable<typeof n> => n !== undefined);
  const evidence: CallEdgeEvidence[] = [];
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();

  for (const edge of edges) {
    const from = toGraphSymbolRef(edge.owner);
    const to = toGraphSymbolRef(edge.target);
    if (from === undefined || to === undefined) continue;
    evidence.push({
      from,
      to,
      callSite: {
        filePath: edge.owner.filePath,
        line: edge.callSite.line,
        column: edge.callSite.column,
      },
      resolution: edge.resolution,
      confidence: edge.confidence,
      crossShard: edge.crossShard,
    });
    if (!forward.has(from.symbolId)) forward.set(from.symbolId, new Set());
    if (!reverse.has(to.symbolId)) reverse.set(to.symbolId, new Set());
    forward.get(from.symbolId)!.add(to.symbolId);
    reverse.get(to.symbolId)!.add(from.symbolId);
  }

  const unresolved = graph.unresolved
    .filter((u) => include.has(u.ownerOccId))
    .slice(0, MAX_UNRESOLVED)
    .map((u) => ({
      ownerSymbolId: occId(u.owner),
      resolution: u.resolution,
      confidence: u.confidence,
    }));

  return {
    nodes,
    edges: evidence,
    forward: freezeMap(forward),
    reverse: freezeMap(reverse),
    totalMembership: include.size,
    counts: {
      includedOccurrences: include.size,
      excludedOccurrences,
      includedEdges: edges.length,
      excludedEdges,
      countScope: 'visited',
    },
    unresolved,
    coverage: {
      complete: graph.unresolved.filter((u) => include.has(u.ownerOccId)).length <= MAX_UNRESOLVED,
      truncated: graph.unresolved.filter((u) => include.has(u.ownerOccId)).length > MAX_UNRESOLVED,
      reasons:
        graph.unresolved.filter((u) => include.has(u.ownerOccId)).length > MAX_UNRESOLVED
          ? ['unresolved-sample-cap']
          : [],
    },
  };
}

function projectTwinView(
  include: ReadonlyMap<string, FunctionOccurrence>,
  edges: readonly ResolvedOccurrenceEdge[],
  graph: OccurrenceCallGraph,
  excludedOccurrences: number,
  excludedEdges: number,
): OccurrenceCallView {
  // Group surviving nodes by body hash; edge endpoints already filtered.
  const byHash = new Map<string, FunctionOccurrence[]>();
  for (const occ of include.values()) {
    const list = byHash.get(occ.bodyHash) ?? [];
    list.push(occ);
    byHash.set(occ.bodyHash, list);
  }
  const nodes = [...include.values()]
    .map((occ) => toGraphSymbolRef(occ))
    .filter((n): n is NonNullable<typeof n> => n !== undefined);

  const evidence: CallEdgeEvidence[] = [];
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  for (const edge of edges) {
    const from = toGraphSymbolRef(edge.owner);
    const to = toGraphSymbolRef(edge.target);
    if (from === undefined || to === undefined) continue;
    evidence.push({
      from,
      to,
      callSite: {
        filePath: edge.owner.filePath,
        line: edge.callSite.line,
        column: edge.callSite.column,
      },
      resolution: edge.resolution,
      confidence: edge.confidence,
      crossShard: edge.crossShard,
    });
    // Twin adjacency keyed by body hash.
    if (!forward.has(from.bodyHash)) forward.set(from.bodyHash, new Set());
    if (!reverse.has(to.bodyHash)) reverse.set(to.bodyHash, new Set());
    forward.get(from.bodyHash)!.add(to.bodyHash);
    reverse.get(to.bodyHash)!.add(from.bodyHash);
  }

  const unresolved = graph.unresolved
    .filter((u) => include.has(u.ownerOccId))
    .slice(0, MAX_UNRESOLVED)
    .map((u) => ({
      ownerSymbolId: occId(u.owner),
      resolution: u.resolution,
      confidence: u.confidence,
    }));

  return {
    nodes,
    edges: evidence,
    forward: freezeMap(forward),
    reverse: freezeMap(reverse),
    totalMembership: include.size,
    counts: {
      includedOccurrences: include.size,
      excludedOccurrences,
      includedEdges: edges.length,
      excludedEdges,
      countScope: 'visited',
    },
    unresolved,
    coverage: {
      complete: true,
      truncated: false,
      reasons: [],
    },
  };
}

function freezeMap(input: Map<string, Set<string>>): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [k, set] of input) out.set(k, [...set]);
  return out;
}
