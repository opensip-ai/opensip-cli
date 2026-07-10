/**
 * Live runtime wiring read port — logical tool/manifest/CommandSpec evidence
 * that a static call graph cannot represent.
 */

import type { McpReadError } from './mcp-error.js';
import type { Result } from '@opensip-cli/core';

export interface RuntimeWiringQuery {
  readonly tool?: string;
  readonly command?: string;
  readonly provenanceSource?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly groupBy?: 'none' | 'package' | 'file' | 'tool' | 'source';
}

export interface RuntimeWiringNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly tool?: string;
  readonly source?: string;
}

export interface RuntimeWiringEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly source: 'manifest' | 'provenance' | 'registry' | 'command-spec' | 'host-contract';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly staticBridge?: 'unresolved' | 'partial';
}

export interface RuntimeWiringResult {
  readonly nodes: readonly RuntimeWiringNode[];
  readonly edges: readonly RuntimeWiringEdge[];
  readonly page?: { readonly limit: number; readonly nextCursor?: string };
  readonly coverage: {
    readonly complete: boolean;
    readonly truncated: boolean;
    readonly reasons: readonly string[];
  };
  readonly effectiveFilters: RuntimeWiringQuery;
}

export interface RuntimeWiringReadPort {
  query(input: RuntimeWiringQuery): Promise<Result<RuntimeWiringResult, McpReadError>>;
}
