/**
 * Pure static-handler bridge helpers (P2 Phase 4.7).
 *
 * Descriptor dedupe and result overlay only — no graph/catalog I/O.
 * Production injects GraphReadPort.resolveStaticHandlerDeclarations for lookup.
 */

import type { RuntimeWiringEdge, RuntimeWiringNode } from './runtime-wiring-read-port.js';
import type { StaticHandlerDescriptor } from '@opensip-cli/core';

/** Max descriptors accepted in one batch join. */
export const MAX_STATIC_HANDLER_DESCRIPTORS = 2000;
/** Max declaration candidates retained per descriptor before ambiguous/cap. */
export const MAX_STATIC_HANDLER_CANDIDATES = 8;
/** Max completed bridge cache entries (w1:+g1:). */
export const MAX_STATIC_HANDLER_CACHE_ENTRIES = 4;

/** Provenance + match-basis stamped on every author-declared static-handler outcome. */
const CLAIM_PROVENANCE_AUTHOR_DECLARED = 'author-declared' as const;
const MATCH_BASIS_AUTHOR_DECLARED = 'author-declared-exact-declaration' as const;

export type StaticBridgeStatus =
  | 'resolved'
  | 'metadata-missing'
  | 'catalog-missing'
  | 'declarations-unsupported'
  | 'provenance-mismatch'
  | 'package-mismatch'
  | 'path-mismatch'
  | 'not-found'
  | 'ambiguous'
  | 'candidate-cap'
  | 'outside-catalog';

export interface StaticHandlerRef {
  readonly package: string;
  readonly path: string;
  readonly declaration: string;
  /** Admitted plugin package identity when the command is tool-owned. */
  readonly admittedPackageIdentity?: string;
  /** Owner of the runtime command leaf. */
  readonly owner?: 'host' | 'tool';
}

export interface StaticHandlerBridgeLimits {
  readonly maxDescriptors: number;
  readonly maxCandidates: number;
}

export const DEFAULT_STATIC_HANDLER_BRIDGE_LIMITS: Readonly<StaticHandlerBridgeLimits> =
  Object.freeze({
    maxDescriptors: MAX_STATIC_HANDLER_DESCRIPTORS,
    maxCandidates: MAX_STATIC_HANDLER_CANDIDATES,
  });

export interface StaticHandlerBridgeOutcome {
  readonly ref: StaticHandlerRef;
  readonly status: StaticBridgeStatus;
  readonly declarationId?: string;
  readonly declarationQualifiedName?: string;
  readonly matchBasis?: 'author-declared-exact-declaration';
  readonly claimProvenance?: 'author-declared';
  readonly confidence?: 'high' | 'medium' | 'low';
  readonly reason?: string;
}

/** Closed set of reviewed first-party cross-package handler mappings. */
export const REVIEWED_CROSS_PACKAGE_HANDLERS: readonly StaticHandlerDescriptor[] = Object.freeze([
  Object.freeze({
    package: '@opensip-cli/contracts',
    path: 'packages/contracts/src/analysis-run-command.ts',
    declaration: 'runAnalysisCommand',
  }),
  Object.freeze({
    package: '@opensip-cli/external-tool-adapter',
    path: 'packages/external-tool-adapter/src/define-external-tool-adapter.ts',
    declaration: 'dispatchExternalScan',
  }),
]);

function descriptorKey(ref: Pick<StaticHandlerRef, 'package' | 'path' | 'declaration'>): string {
  return `${ref.package}\0${ref.path}\0${ref.declaration}`;
}

function isReviewedCrossPackage(ref: StaticHandlerRef): boolean {
  return REVIEWED_CROSS_PACKAGE_HANDLERS.some(
    (allowed) =>
      allowed.package === ref.package &&
      allowed.path === ref.path &&
      allowed.declaration === ref.declaration,
  );
}

/**
 * Deduplicate descriptors for one batch join while preserving first-seen order.
 * Fails closed when N+1 descriptors are supplied.
 *
 * @throws {Error} When `refs.length` exceeds `limits.maxDescriptors`.
 */
export function dedupeStaticHandlerRefs(
  refs: readonly StaticHandlerRef[],
  limits: StaticHandlerBridgeLimits = DEFAULT_STATIC_HANDLER_BRIDGE_LIMITS,
): readonly StaticHandlerRef[] {
  if (refs.length > limits.maxDescriptors) {
    throw new Error(
      `static handler bridge exceeds maxDescriptors (${String(limits.maxDescriptors)}); got ${String(refs.length)}.`,
    );
  }
  const seen = new Set<string>();
  const out: StaticHandlerRef[] = [];
  for (const ref of refs) {
    const key = descriptorKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * Apply provenance/package policy before catalog lookup.
 * Returns a terminal unresolved outcome when the claim is not admissible.
 */
export function preflightStaticHandlerRef(
  ref: StaticHandlerRef,
): StaticHandlerBridgeOutcome | undefined {
  if (
    ref.owner === 'tool' &&
    ref.admittedPackageIdentity !== undefined &&
    ref.package !== ref.admittedPackageIdentity &&
    !isReviewedCrossPackage(ref)
  ) {
    return {
      ref,
      status: 'provenance-mismatch',
      claimProvenance: CLAIM_PROVENANCE_AUTHOR_DECLARED,
      matchBasis: MATCH_BASIS_AUTHOR_DECLARED,
      confidence: 'low',
      reason: 'claimed-package-differs-from-admitted-plugin-identity',
    };
  }
  return undefined;
}

export interface DeclarationCandidate {
  readonly declarationId: string;
  readonly package: string;
  readonly filePath: string;
  readonly name: string;
  readonly qualifiedName: string;
}

/**
 * Match one descriptor against catalog candidates (exact package+path+name).
 * Pure; maxCandidates injected for tests.
 */
export function matchStaticHandlerCandidates(
  ref: StaticHandlerRef,
  candidates: readonly DeclarationCandidate[],
  limits: StaticHandlerBridgeLimits = DEFAULT_STATIC_HANDLER_BRIDGE_LIMITS,
): StaticHandlerBridgeOutcome {
  const preflight = preflightStaticHandlerRef(ref);
  if (preflight !== undefined) return preflight;

  const exact = candidates.filter(
    (c) =>
      c.package === ref.package &&
      c.filePath === ref.path &&
      (c.name === ref.declaration ||
        c.qualifiedName === ref.declaration ||
        c.qualifiedName.endsWith(`.${ref.declaration}`)),
  );

  if (exact.length === 0) {
    return {
      ref,
      status: 'not-found',
      claimProvenance: CLAIM_PROVENANCE_AUTHOR_DECLARED,
      matchBasis: MATCH_BASIS_AUTHOR_DECLARED,
      confidence: 'low',
    };
  }
  if (exact.length > limits.maxCandidates) {
    return {
      ref,
      status: 'candidate-cap',
      claimProvenance: CLAIM_PROVENANCE_AUTHOR_DECLARED,
      matchBasis: MATCH_BASIS_AUTHOR_DECLARED,
      confidence: 'low',
      reason: `candidates-exceed-${String(limits.maxCandidates)}`,
    };
  }
  if (exact.length > 1) {
    return {
      ref,
      status: 'ambiguous',
      claimProvenance: CLAIM_PROVENANCE_AUTHOR_DECLARED,
      matchBasis: MATCH_BASIS_AUTHOR_DECLARED,
      confidence: 'low',
      reason: `matches-${String(exact.length)}`,
    };
  }
  const hit = exact[0];
  return {
    ref,
    status: 'resolved',
    declarationId: hit.declarationId,
    declarationQualifiedName: hit.qualifiedName,
    claimProvenance: CLAIM_PROVENANCE_AUTHOR_DECLARED,
    matchBasis: MATCH_BASIS_AUTHOR_DECLARED,
    confidence: 'medium',
  };
}

/**
 * Overlay bridge outcomes onto handler nodes and dispatch edges.
 * Does not add call-graph adjacency.
 */
export function overlayStaticHandlerBridge(
  nodes: readonly RuntimeWiringNode[],
  edges: readonly RuntimeWiringEdge[],
  outcomesByHandlerPath: ReadonlyMap<string, StaticHandlerBridgeOutcome>,
): {
  readonly nodes: readonly RuntimeWiringNode[];
  readonly edges: readonly RuntimeWiringEdge[];
  readonly resolvedCount: number;
  readonly unresolvedCount: number;
} {
  let resolvedCount = 0;
  let unresolvedCount = 0;
  const nextNodes = nodes.map((node) => {
    if (node.kind !== 'handler' || node.commandPath === undefined) return node;
    const outcome = outcomesByHandlerPath.get(node.commandPath);
    if (outcome === undefined) {
      if (node.staticHandlerDeclaration === undefined) unresolvedCount += 1;
      return node;
    }
    if (outcome.status === 'resolved') {
      resolvedCount += 1;
      return Object.freeze({
        ...node,
        declarationId: outcome.declarationId,
        declarationQualifiedName: outcome.declarationQualifiedName,
      });
    }
    unresolvedCount += 1;
    return node;
  });

  const nextEdges = edges.map((edge) => {
    if (edge.kind !== 'command-dispatches-handler') return edge;
    const handler = nextNodes.find((n) => n.id === edge.to && n.kind === 'handler');
    if (handler === undefined) return edge;
    const outcome =
      handler.commandPath === undefined
        ? undefined
        : outcomesByHandlerPath.get(handler.commandPath);
    if (outcome?.status === 'resolved') {
      return Object.freeze({
        ...edge,
        staticBridge: 'resolved' as const,
        matchBasis: outcome.matchBasis,
        claimProvenance: outcome.claimProvenance,
        confidence: outcome.confidence ?? edge.confidence,
      });
    }
    return Object.freeze({
      ...edge,
      staticBridge: 'unresolved' as const,
      ...(outcome === undefined
        ? {}
        : {
            reason: outcome.reason ?? outcome.status,
            matchBasis: outcome.matchBasis,
            claimProvenance: outcome.claimProvenance,
          }),
    });
  });

  return {
    nodes: Object.freeze(nextNodes),
    edges: Object.freeze(nextEdges),
    resolvedCount,
    unresolvedCount,
  };
}

export type ResolveStaticHandlers = (
  runtimeSnapshotKey: string,
  refs: readonly StaticHandlerRef[],
) => Promise<{
  readonly catalogIdentity?: string;
  readonly outcomes: readonly StaticHandlerBridgeOutcome[];
  readonly catalogStatus: 'loaded' | 'missing' | 'unsupported';
}>;
