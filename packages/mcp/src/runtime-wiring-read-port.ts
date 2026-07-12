/**
 * Storage-independent live runtime wiring evidence.
 *
 * This projection describes admitted manifest/registry/command-inventory wiring.
 * It is deliberately distinct from the source call graph.
 */

import type { GroupSummary } from './graph-query-page.js';
import type { McpReadError } from './mcp-error.js';
import type { Result, ToolSource } from '@opensip-cli/core';

export type RuntimeWiringGroupBy = 'none' | 'tool' | 'source' | 'owner';

/** Exclusive compact representation for runtime wiring (P2 Phase 4.6). */
export type RuntimeWiringDetail = 'summary' | 'groups' | 'nodes';

export interface RuntimeWiringQuery {
  readonly tool?: string;
  readonly command?: string;
  readonly provenanceSource?: ToolSource;
  readonly limit?: number;
  readonly cursor?: string;
  readonly groupBy?: RuntimeWiringGroupBy;
  /** Exclusive projection. Default `summary`. */
  readonly detail?: RuntimeWiringDetail;
}

export type RuntimeWiringNodeKind =
  | 'manifest'
  | 'provenance'
  | 'tool'
  | 'command'
  | 'command-group'
  | 'handler'
  | 'host-mount'
  | 'worker-posture';

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
  readonly owner?: 'host' | 'tool';
  readonly commandPath?: string;
  readonly visibility?: 'public' | 'internal';
  readonly aliases?: readonly string[];
  readonly staticHandlerPackage?: string;
  readonly staticHandlerPath?: string;
  readonly staticHandlerDeclaration?: string;
  /** Set when the static-handler bridge resolves a unique declaration. */
  readonly declarationId?: string;
  readonly declarationQualifiedName?: string;
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
  readonly matchBasis?: string;
  readonly claimProvenance?: string;
}

export interface RuntimeWiringSummary {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly toolCount: number;
  readonly commandCount: number;
  readonly handlerCount: number;
  readonly hostCommandCount: number;
  readonly groupCount: number;
  readonly resolvedBridgeCount: number;
  readonly unresolvedBridgeCount: number;
}

export interface RuntimeWiringResult {
  readonly context: {
    readonly project: {
      readonly root: string;
      readonly scope: 'project';
      readonly configPath: string;
    };
    readonly runtime: {
      readonly kind: 'runtime-wiring';
      /** Stable `w1:` identity (excludes capturedAt). */
      readonly identity: string;
      readonly capturedAt: string;
    };
    /**
     * Opaque project digest for cursor binding only — never treat as response
     * context for agents (prefer context.project.root).
     */
    readonly projectKey: string;
    /** @deprecated Prefer context.runtime.identity (`w1:`). */
    readonly snapshotKey: string;
  };
  readonly summary?: RuntimeWiringSummary;
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
    /** Completeness within captured registry + command inventory boundary. */
    readonly complete: boolean;
    readonly scope: 'captured-admitted-registry-and-command-inventory';
    readonly truncated: boolean;
    readonly reasons: readonly string[];
    readonly runtimeInventoryComplete?: boolean;
    readonly staticBridgeComplete?: boolean;
  };
  readonly effectiveFilters: Required<Pick<RuntimeWiringQuery, 'limit' | 'groupBy' | 'detail'>> &
    Pick<RuntimeWiringQuery, 'tool' | 'command' | 'provenanceSource'>;
}

export interface RuntimeWiringReadPort {
  query(input: RuntimeWiringQuery): Promise<Result<RuntimeWiringResult, McpReadError>>;
}
