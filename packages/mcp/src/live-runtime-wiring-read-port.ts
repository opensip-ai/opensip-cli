/** Production read port over one immutable captured runtime-wiring snapshot. */

import { err, ok, type Result } from '@opensip-cli/core';

import { digestNormalizedQuery, pageRows } from './graph-query-page.js';
import { readError, type McpReadError } from './mcp-error.js';
import {
  MAX_RUNTIME_EDGES,
  resolveCanonicalRuntimeTool,
  type LiveRuntimeWiringDeps,
  type RuntimeToolIdentityIndex,
} from './runtime-wiring-capture.js';
import { filterRuntimeSnapshot, groupRuntimeNodes } from './runtime-wiring-filter.js';
import {
  buildRuntimeWiringSnapshot,
  type RuntimeWiringSnapshot,
} from './runtime-wiring-snapshot.js';
import {
  descriptorKey,
  overlayStaticHandlerBridge,
  type ResolveStaticHandlers,
  type StaticHandlerBridgeOutcome,
  type StaticHandlerRef,
} from './static-handler-bridge.js';

import type {
  RuntimeWiringDetail,
  RuntimeWiringQuery,
  RuntimeWiringReadPort,
  RuntimeWiringResult,
  RuntimeWiringSummary,
} from './runtime-wiring-read-port.js';

const MAX_PAGE_EDGES_PER_NODE = 4;

export type { LiveRuntimeWiringDeps } from './runtime-wiring-capture.js';

export interface LiveRuntimeWiringReadPortOptions extends LiveRuntimeWiringDeps {
  /**
   * Optional batch static-handler bridge. Production wires
   * GraphReadPort.resolveStaticHandlerDeclarations; unit tests inject a fake.
   * The live port owns no graph-generation cache — the collaborator does.
   */
  readonly resolveStaticHandlers?: ResolveStaticHandlers;
}

function validateDetail(
  detail: RuntimeWiringDetail,
  groupBy: RuntimeWiringQuery['groupBy'],
): Result<void, McpReadError> {
  if (detail === 'groups' && (groupBy === undefined || groupBy === 'none')) {
    return err(
      readError('invalid-query', 'detail=groups requires groupBy tool, source, or owner.'),
    );
  }
  if ((detail === 'summary' || detail === 'nodes') && groupBy !== undefined && groupBy !== 'none') {
    return err(
      readError(
        'invalid-query',
        'detail=summary and detail=nodes require groupBy none (or omit groupBy).',
      ),
    );
  }
  return ok(undefined);
}

function summarizeNodeKinds(nodes: RuntimeWiringResult['nodes']): {
  readonly toolCount: number;
  readonly commandCount: number;
  readonly handlerCount: number;
  readonly hostCommandCount: number;
  readonly groupCount: number;
} {
  let toolCount = 0;
  let commandCount = 0;
  let handlerCount = 0;
  let hostCommandCount = 0;
  let groupCount = 0;
  for (const node of nodes) {
    if (node.kind === 'tool') toolCount += 1;
    if (node.kind === 'command') {
      commandCount += 1;
      if (node.owner === 'host') hostCommandCount += 1;
    }
    if (node.kind === 'handler') handlerCount += 1;
    if (node.kind === 'command-group') groupCount += 1;
  }
  return { toolCount, commandCount, handlerCount, hostCommandCount, groupCount };
}

function summarizeBridges(edges: RuntimeWiringResult['edges']): {
  readonly resolvedBridgeCount: number;
  readonly unresolvedBridgeCount: number;
} {
  let resolvedBridgeCount = 0;
  let unresolvedBridgeCount = 0;
  for (const edge of edges) {
    if (edge.kind !== 'command-dispatches-handler') continue;
    if (edge.staticBridge === 'resolved') resolvedBridgeCount += 1;
    else if (edge.staticBridge === 'unresolved') unresolvedBridgeCount += 1;
  }
  return { resolvedBridgeCount, unresolvedBridgeCount };
}

function summarize(
  nodes: RuntimeWiringResult['nodes'],
  edges: RuntimeWiringResult['edges'],
): RuntimeWiringSummary {
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    ...summarizeNodeKinds(nodes),
    ...summarizeBridges(edges),
  };
}

function collectHandlerRefs(snapshot: RuntimeWiringSnapshot): {
  readonly refs: StaticHandlerRef[];
  readonly pathByKey: Map<string, string[]>;
} {
  const refs: StaticHandlerRef[] = [];
  const pathByKey = new Map<string, string[]>();
  for (const node of snapshot.nodes) {
    if (node.kind !== 'handler') continue;
    if (
      node.staticHandlerPackage === undefined ||
      node.staticHandlerPath === undefined ||
      node.staticHandlerDeclaration === undefined ||
      node.commandPath === undefined
    ) {
      continue;
    }
    const ref: StaticHandlerRef = {
      package: node.staticHandlerPackage,
      path: node.staticHandlerPath,
      declaration: node.staticHandlerDeclaration,
      ...(node.packageName === undefined ? {} : { admittedPackageIdentity: node.packageName }),
      ...(node.owner === undefined ? {} : { owner: node.owner }),
    };
    const key = descriptorKey(ref);
    const paths = pathByKey.get(key) ?? [];
    paths.push(node.commandPath);
    pathByKey.set(key, paths);
    if (paths.length === 1) refs.push(ref);
  }
  return { refs, pathByKey };
}

/**
 * Map batch resolution outcomes onto command paths, then mark every
 * metadata-missing handler node (no declared static handler) as such.
 */
function mapOutcomesByPath(
  outcomes: readonly StaticHandlerBridgeOutcome[],
  pathByKey: ReadonlyMap<string, string[]>,
  snapshot: RuntimeWiringSnapshot,
): Map<string, StaticHandlerBridgeOutcome> {
  const byPath = new Map<string, StaticHandlerBridgeOutcome>();
  for (const outcome of outcomes) {
    const key = descriptorKey(outcome.ref);
    for (const path of pathByKey.get(key) ?? []) {
      byPath.set(path, outcome);
    }
  }
  // Also mark metadata-missing handlers.
  for (const node of snapshot.nodes) {
    if (
      node.kind === 'handler' &&
      node.commandPath !== undefined &&
      node.staticHandlerDeclaration === undefined
    ) {
      byPath.set(node.commandPath, {
        ref: {
          package: '',
          path: '',
          declaration: '',
        },
        status: 'metadata-missing',
        claimProvenance: 'author-declared',
        matchBasis: 'author-declared-exact-declaration',
        confidence: 'low',
      });
    }
  }
  return byPath;
}

/** Deterministic, session-free runtime-wiring reader for the captured host state. */
export class LiveRuntimeWiringReadPort implements RuntimeWiringReadPort {
  private readonly snapshot: RuntimeWiringSnapshot;
  private readonly identityIndex: RuntimeToolIdentityIndex;
  private readonly resolveStaticHandlers: ResolveStaticHandlers | undefined;

  constructor(deps: LiveRuntimeWiringReadPortOptions) {
    this.snapshot = buildRuntimeWiringSnapshot(deps);
    this.identityIndex = this.snapshot.identityIndex;
    this.resolveStaticHandlers = deps.resolveStaticHandlers;
  }

  /**
   * Overlay the static-handler bridge on every request (the collaborator caches
   * by w1:+g1:). Returns the snapshot nodes/edges unchanged when no resolver is
   * wired or there are no handler refs; otherwise the overlaid graph.
   */
  private async applyStaticBridge(): Promise<{
    readonly nodes: RuntimeWiringSnapshot['nodes'];
    readonly edges: RuntimeWiringSnapshot['edges'];
    readonly staticBridgeComplete: boolean;
  }> {
    const nodes = this.snapshot.nodes;
    const edges = this.snapshot.edges;
    const staticBridgeComplete = this.snapshot.coverage.staticBridgeComplete ?? false;
    if (this.resolveStaticHandlers === undefined) {
      return { nodes, edges, staticBridgeComplete };
    }
    const { refs, pathByKey } = collectHandlerRefs(this.snapshot);
    if (refs.length === 0) {
      return { nodes, edges, staticBridgeComplete: true };
    }
    const batch = await this.resolveStaticHandlers(this.snapshot.snapshotKey, refs);
    const byPath = mapOutcomesByPath(batch.outcomes, pathByKey, this.snapshot);
    const overlaid = overlayStaticHandlerBridge(nodes, edges, byPath);
    return {
      nodes: overlaid.nodes,
      edges: overlaid.edges,
      staticBridgeComplete: batch.catalogStatus === 'loaded' && overlaid.unresolvedCount === 0,
    };
  }

  async query(input: RuntimeWiringQuery): Promise<Result<RuntimeWiringResult, McpReadError>> {
    try {
      const detail: RuntimeWiringDetail = input.detail ?? 'summary';
      const groupBy = input.groupBy ?? 'none';
      const detailOk = validateDetail(detail, groupBy);
      if (!detailOk.ok) return detailOk;

      const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
      const canonicalTool =
        input.tool === undefined
          ? undefined
          : resolveCanonicalRuntimeTool(input.tool, this.identityIndex);

      const bridged = await this.applyStaticBridge();
      const staticBridgeComplete = bridged.staticBridgeComplete;

      const filtered = filterRuntimeSnapshot(
        { nodes: bridged.nodes, edges: bridged.edges },
        input,
        canonicalTool,
      );
      const effectiveFilters = {
        tool: canonicalTool,
        command: input.command?.toLowerCase(),
        provenanceSource: input.provenanceSource,
        limit,
        groupBy,
        detail,
      };
      const queryDigest = digestNormalizedQuery(effectiveFilters);
      const coverageBase = {
        ...this.snapshot.coverage,
        staticBridgeComplete,
      };

      const context: RuntimeWiringResult['context'] = {
        project: {
          root: this.snapshot.projectRoot,
          scope: 'project',
          configPath: this.snapshot.configPath,
        },
        runtime: {
          kind: 'runtime-wiring',
          identity: this.snapshot.snapshotKey,
          capturedAt: this.snapshot.capturedAt,
        },
        projectKey: this.snapshot.projectKey,
        snapshotKey: this.snapshot.snapshotKey,
      };

      if (detail === 'summary') {
        const summary = summarize(filtered.nodes, filtered.edges);
        return ok({
          context,
          summary,
          nodes: [],
          edges: [],
          page: { limit, hasMore: false, edgeTruncated: false },
          groupTruncated: false,
          coverage: coverageBase,
          effectiveFilters,
        });
      }

      if (detail === 'groups') {
        const grouped = groupRuntimeNodes(filtered.nodes, groupBy);
        return ok({
          context,
          nodes: [],
          edges: [],
          page: { limit, hasMore: false, edgeTruncated: false },
          groups: grouped.groups,
          groupTruncated: grouped.groupTruncated,
          coverage: {
            ...coverageBase,
            complete: coverageBase.complete && !grouped.groupTruncated,
            truncated: coverageBase.truncated || grouped.groupTruncated,
            reasons: grouped.groupTruncated
              ? [...new Set([...coverageBase.reasons, 'group-key-cap'])]
              : coverageBase.reasons,
          },
          effectiveFilters,
        });
      }

      // detail === 'nodes'
      const page = pageRows(
        filtered.nodes,
        {
          projectKey: this.snapshot.projectKey,
          generationKey: this.snapshot.snapshotKey,
          queryDigest,
          limit,
          cursor: input.cursor,
        },
        (node) => node.id,
      );
      if (!page.ok) return page;
      const pageIds = new Set(page.value.rows.map((node) => node.id));
      const pageEdges = filtered.edges.filter(
        (edge) => pageIds.has(edge.from) || pageIds.has(edge.to),
      );
      const edgeLimit = Math.min(MAX_RUNTIME_EDGES, limit * MAX_PAGE_EDGES_PER_NODE);
      const edgeTruncated = pageEdges.length > edgeLimit;
      const pageReasons = [...(edgeTruncated ? ['page-edge-cap'] : [])];
      const coverage =
        pageReasons.length > 0
          ? {
              ...coverageBase,
              complete: false,
              truncated: true,
              reasons: [...new Set([...coverageBase.reasons, ...pageReasons])],
            }
          : coverageBase;
      return ok({
        context,
        nodes: page.value.rows,
        edges: pageEdges.slice(0, edgeLimit),
        page: {
          limit,
          hasMore: page.value.hasMore,
          nextCursor: page.value.nextCursor,
          edgeTruncated,
        },
        groupTruncated: false,
        coverage,
        effectiveFilters,
      });
    } catch {
      return err(readError('runtime-wiring-failed', 'Failed to query runtime wiring snapshot.'));
    }
  }
}
