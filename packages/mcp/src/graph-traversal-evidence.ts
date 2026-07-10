import type { TraversalHopDto, TraversalNodeDto, TraversalQuery } from './graph-read-port.js';
import type { SymbolRef } from './symbol-dto.js';
import type {
  CallEdgeEvidence,
  OccurrenceCallView,
  TraversalIdentity,
} from '@opensip-cli/graph/read';

const MAX_HOP_EVIDENCE = 50;

function edgeKey(symbol: CallEdgeEvidence['from'], identity: TraversalIdentity): string {
  return identity === 'occurrence' ? symbol.symbolId : symbol.bodyHash;
}

function evidenceBetween(
  view: OccurrenceCallView,
  parent: string,
  child: string,
  direction: TraversalQuery['direction'],
  identity: TraversalIdentity,
): CallEdgeEvidence[] {
  const expectedFrom = direction === 'callers' ? child : parent;
  const expectedTo = direction === 'callers' ? parent : child;
  return view.edges.filter(
    (edge) =>
      edgeKey(edge.from, identity) === expectedFrom && edgeKey(edge.to, identity) === expectedTo,
  );
}

/** Chooses one stable occurrence for every group in a returned path. */
export function pathSymbols(
  view: OccurrenceCallView,
  path: readonly string[],
  query: TraversalQuery,
  identity: TraversalIdentity,
): SymbolRef[] {
  const symbols: SymbolRef[] = [];
  for (const [index, groupId] of path.entries()) {
    const members = view.members.get(groupId) ?? [];
    let requestedId: string | undefined;
    if (index === 0) requestedId = query.startSymbolId;
    else if (index === path.length - 1) requestedId = query.goalSymbolId;
    const requested = members.find((member) => member.symbolId === requestedId);
    if (requested !== undefined) {
      symbols.push(requested);
      continue;
    }
    const prior = path[index - 1];
    const contributing =
      prior === undefined
        ? undefined
        : evidenceBetween(view, prior, groupId, 'path', identity)[0]?.to;
    const member =
      contributing === undefined
        ? members[0]
        : members.find((candidate) => candidate.symbolId === contributing.symbolId);
    if (member !== undefined) symbols.push(member);
  }
  return symbols;
}

function incomingEvidence(input: {
  readonly view: OccurrenceCallView;
  readonly parent: string;
  readonly child: string;
  readonly symbolId: string;
  readonly direction: TraversalQuery['direction'];
  readonly identity: TraversalIdentity;
}): CallEdgeEvidence | undefined {
  const evidence = evidenceBetween(
    input.view,
    input.parent,
    input.child,
    input.direction,
    input.identity,
  );
  return evidence.find((edge) =>
    input.direction === 'callers'
      ? edge.from.symbolId === input.symbolId
      : edge.to.symbolId === input.symbolId,
  );
}

/** Projects one traversal member with its incoming edge attribution. */
export function projectTraversalNode(input: {
  readonly view: OccurrenceCallView;
  readonly parent: string | undefined;
  readonly groupId: string;
  readonly member: SymbolRef;
  readonly groupTotal: number;
  readonly depth: number;
  readonly direction: TraversalQuery['direction'];
  readonly identity: TraversalIdentity;
}): TraversalNodeDto {
  const incoming =
    input.parent === undefined
      ? undefined
      : incomingEvidence({
          view: input.view,
          parent: input.parent,
          child: input.groupId,
          symbolId: input.member.symbolId,
          direction: input.direction,
          identity: input.identity,
        });
  return {
    symbol: input.member,
    depth: input.depth,
    groupId: input.groupId,
    groupTotal: input.groupTotal,
    ...(incoming === undefined ? {} : { incomingEvidence: incoming }),
    ...(input.identity === 'body-twin-union' && input.parent !== undefined
      ? { anyTwinMaySupplyHop: true }
      : {}),
  };
}

function weakestConfidence(evidence: readonly CallEdgeEvidence[]): CallEdgeEvidence['confidence'] {
  if (evidence.some((edge) => edge.confidence === 'low')) return 'low';
  if (evidence.some((edge) => edge.confidence === 'medium')) return 'medium';
  return 'high';
}

/** Projects bounded evidence for each hop of a selected path. */
export function pathHops(
  view: OccurrenceCallView,
  path: readonly string[],
  identity: TraversalIdentity,
): TraversalHopDto[] {
  const hops: TraversalHopDto[] = [];
  for (let index = 1; index < path.length; index++) {
    const from = path[index - 1];
    const to = path[index];
    if (from === undefined || to === undefined) continue;
    const allEvidence = evidenceBetween(view, from, to, 'path', identity);
    const evidence = allEvidence.slice(0, MAX_HOP_EVIDENCE);
    hops.push({
      fromGroupId: from,
      toGroupId: to,
      evidence,
      ...(allEvidence.length === 0 ? {} : { weakestConfidence: weakestConfidence(allEvidence) }),
      anyTwinMaySupplyHop: identity === 'body-twin-union',
    });
  }
  return hops;
}

/** Reports whether any selected hop exceeded the evidence cap. */
export function hasTruncatedHopEvidence(
  view: OccurrenceCallView,
  path: readonly string[],
  identity: TraversalIdentity,
): boolean {
  for (let index = 1; index < path.length; index++) {
    const from = path[index - 1];
    const to = path[index];
    if (from === undefined || to === undefined) continue;
    if (evidenceBetween(view, from, to, 'path', identity).length > MAX_HOP_EVIDENCE) return true;
  }
  return false;
}

/** Returns the least-confident retained hop, when the path has evidence. */
export function weakestHopConfidence(
  hops: readonly TraversalHopDto[],
): CallEdgeEvidence['confidence'] | undefined {
  const confidences = hops
    .map((hop) => hop.weakestConfidence)
    .filter((value): value is CallEdgeEvidence['confidence'] => value !== undefined);
  if (confidences.includes('low')) return 'low';
  if (confidences.includes('medium')) return 'medium';
  return confidences.length === 0 ? undefined : 'high';
}
