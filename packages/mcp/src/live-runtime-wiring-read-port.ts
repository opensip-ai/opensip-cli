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

import type {
  RuntimeWiringQuery,
  RuntimeWiringReadPort,
  RuntimeWiringResult,
} from './runtime-wiring-read-port.js';

const MAX_PAGE_EDGES_PER_NODE = 4;

export type { LiveRuntimeWiringDeps } from './runtime-wiring-capture.js';

/** Deterministic, session-free runtime-wiring reader for the captured host state. */
export class LiveRuntimeWiringReadPort implements RuntimeWiringReadPort {
  private readonly snapshot: RuntimeWiringSnapshot;
  private readonly identityIndex: RuntimeToolIdentityIndex;

  constructor(deps: LiveRuntimeWiringDeps) {
    this.snapshot = buildRuntimeWiringSnapshot(deps);
    this.identityIndex = this.snapshot.identityIndex;
  }

  async query(input: RuntimeWiringQuery): Promise<Result<RuntimeWiringResult, McpReadError>> {
    await Promise.resolve();
    try {
      const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
      const groupBy = input.groupBy ?? 'none';
      const canonicalTool =
        input.tool === undefined
          ? undefined
          : resolveCanonicalRuntimeTool(input.tool, this.identityIndex);
      const effectiveFilters = {
        tool: canonicalTool,
        command: input.command?.toLowerCase(),
        provenanceSource: input.provenanceSource,
        limit,
        groupBy,
      };
      const filtered = filterRuntimeSnapshot(this.snapshot, input, canonicalTool);
      const queryDigest = digestNormalizedQuery(effectiveFilters);
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
      const grouped = groupRuntimeNodes(filtered.nodes, groupBy);
      const pageReasons = [
        ...(edgeTruncated ? ['page-edge-cap'] : []),
        ...(grouped.groupTruncated ? ['group-key-cap'] : []),
      ];
      const coverage =
        pageReasons.length > 0
          ? {
              ...this.snapshot.coverage,
              complete: false,
              truncated: true,
              reasons: [...new Set([...this.snapshot.coverage.reasons, ...pageReasons])],
            }
          : this.snapshot.coverage;
      return ok({
        context: {
          projectKey: this.snapshot.projectKey,
          snapshotKey: this.snapshot.snapshotKey,
        },
        nodes: page.value.rows,
        edges: pageEdges.slice(0, edgeLimit),
        page: {
          limit,
          hasMore: page.value.hasMore,
          nextCursor: page.value.nextCursor,
          edgeTruncated,
        },
        groups: grouped.groups,
        groupTruncated: grouped.groupTruncated,
        coverage,
        effectiveFilters,
      });
    } catch {
      return err(readError('runtime-wiring-failed', 'Failed to query runtime wiring snapshot.'));
    }
  }
}
