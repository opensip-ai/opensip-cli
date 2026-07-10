/**
 * Graph evidence DTOs for the MCP read ports (ADR-0084 + MCP Graph Audit).
 *
 * These are the *only* graph shapes that cross the {@link GraphReadPort}
 * boundary — the SQLite impl never leaks `Catalog` / `Indexes` to handlers.
 * Symbol rows reuse the public graph/read {@link GraphSymbolRef} projection.
 */

import type {
  FreshnessChangeSummary,
  FreshnessReasonCode,
  GraphSymbolRef,
} from '@opensip-cli/graph/read';

/** Public symbol row — alias of graph/read projection (no MCP remapping). */
export type SymbolRef = GraphSymbolRef;

/**
 * Project + catalog identity on every graph response.
 * `catalog.identity` is the only public generation key (`g1:…`).
 */
export interface GraphEvidenceContext {
  readonly project: {
    readonly root: string;
    readonly scope: 'project';
    readonly configPath: string;
  };
  readonly catalog: {
    readonly status: 'loaded' | 'missing';
    readonly builtAt?: string;
    readonly language?: string;
    readonly resolutionMode?: 'exact' | 'fast';
    readonly engineMode?: 'exact' | 'sharded';
    /** Canonical `g1:` generation key — never raw CatalogIdentity fields. */
    readonly identity?: string;
    readonly loadedAt?: string;
    readonly generationSource?: 'initial-load' | 'persisted-auto-swap' | 'refresh-rebuild';
  };
}

/**
 * Complete freshness verdict. `verification: 'partial'` never claims
 * unqualified `fresh: true`.
 */
export interface Freshness {
  readonly fresh: boolean;
  readonly builtAt?: string;
  readonly verifiedAt: string;
  readonly verification: 'complete' | 'partial' | 'missing';
  readonly reasonCode?: FreshnessReasonCode | 'missing';
  readonly reason?: string;
  readonly changes?: FreshnessChangeSummary;
}

export interface GraphPageMeta {
  readonly limit: number;
  readonly nextCursor?: string;
}

export interface GraphCoverage {
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly reasons: readonly string[];
}

/**
 * Shared graph-read envelope. `page.nextCursor` and `coverage.truncated` are
 * independent — never conflate pagination with incomplete evidence.
 */
export interface GraphToolResult<T> {
  readonly data: T;
  readonly context: GraphEvidenceContext;
  readonly freshness: Freshness;
  readonly page?: GraphPageMeta;
  readonly coverage: GraphCoverage;
}
