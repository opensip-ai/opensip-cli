/**
 * Storage-independent live runtime wiring evidence.
 *
 * This projection describes admitted manifest/registry/CommandSpec wiring. It
 * is deliberately distinct from the source call graph.
 */

import type { GroupSummary } from './graph-query-page.js';
import type { McpReadError } from './mcp-error.js';
import type { Result, ToolSource } from '@opensip-cli/core';

export type RuntimeWiringGroupBy = 'none' | 'tool' | 'source';

export interface RuntimeWiringQuery {
  readonly tool?: string;
  readonly command?: string;
  readonly provenanceSource?: ToolSource;
  readonly limit?: number;
  readonly cursor?: string;
  readonly groupBy?: RuntimeWiringGroupBy;
}

export type RuntimeWiringNodeKind =
  'manifest' | 'provenance' | 'tool' | 'command' | 'handler' | 'host-mount' | 'worker-posture';

export interface RuntimeWiringNode {
  readonly id: string;
  readonly kind: RuntimeWiringNodeKind;
  readonly label: string;
  readonly tool?: string;
  readonly layoutKey?: string;
  readonly source?: RuntimeWiringEdgeSource;
  readonly provenanceSource?: ToolSource;
  readonly version?: string;
  readonly packageName?: string;
  readonly workerPosture?: 'in-process' | 'isolated-worker-proxy';
  readonly handlerName?: string;
  readonly handlerArity?: number;
}

export type RuntimeWiringEdgeSource =
  'manifest' | 'provenance' | 'registry' | 'command-spec' | 'host-contract';

export type RuntimeWiringEdgeKind =
  | 'manifest-admits-tool'
  | 'registry-owns-command'
  | 'command-nests-under'
  | 'host-mounts-command'
  | 'command-dispatches-handler'
  | 'external-worker-dispatch';

export interface RuntimeWiringEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: RuntimeWiringEdgeKind;
  readonly source: RuntimeWiringEdgeSource;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly staticBridge: 'resolved' | 'unresolved' | 'not-applicable';
  readonly reason?: string;
}

export interface RuntimeWiringResult {
  readonly context: {
    /** Core project key; never the raw project path. */
    readonly projectKey: string;
    /** Opaque identity of the immutable captured runtime snapshot. */
    readonly snapshotKey: string;
  };
  readonly nodes: readonly RuntimeWiringNode[];
  readonly edges: readonly RuntimeWiringEdge[];
  readonly page: {
    readonly limit: number;
    readonly hasMore: boolean;
    readonly nextCursor?: string;
    /** Edges touching this node page exceeded the bounded edge page. */
    readonly edgeTruncated: boolean;
  };
  readonly groups?: readonly GroupSummary[];
  readonly groupTruncated: boolean;
  readonly coverage: {
    /** Completeness within the captured admitted-tool registry boundary. */
    readonly complete: boolean;
    readonly scope: 'captured-admitted-tool-registry';
    readonly truncated: boolean;
    readonly reasons: readonly string[];
  };
  readonly effectiveFilters: Required<Pick<RuntimeWiringQuery, 'limit' | 'groupBy'>> &
    Pick<RuntimeWiringQuery, 'tool' | 'command' | 'provenanceSource'>;
}

export interface RuntimeWiringReadPort {
  query(input: RuntimeWiringQuery): Promise<Result<RuntimeWiringResult, McpReadError>>;
}
