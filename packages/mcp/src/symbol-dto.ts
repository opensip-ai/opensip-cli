/**
 * Graph evidence DTOs for the MCP read ports (ADR-0084 + MCP Graph Audit).
 *
 * These are the *only* graph shapes that cross the {@link GraphReadPort}
 * boundary — the SQLite impl never leaks `Catalog` / `Indexes` to handlers.
 * Symbol rows reuse the public graph/read {@link GraphSymbolRef} projection.
 */

import type {
  EffectiveGraphSourceFilter,
  FreshnessChangeSummary,
  FreshnessReasonCode,
  GraphReadFacetCoverage,
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

/**
 * MCP graph coverage — the compact top-level summary PROJECTED from the
 * graph/read facet coverage (P2 Phase 2.1), not a duplicated triple. Task 2.2
 * migrates the envelope to carry the full four-facet {@link GraphReadFacetCoverage};
 * this alias keeps the summary shape tied to the single graph/read roll-up.
 */
export type GraphCoverage = Pick<GraphReadFacetCoverage, 'complete' | 'truncated' | 'reasons'>;

/** Group summary from bounded `groupBy` projection. */
export interface GraphGroupSummary {
  readonly key: string;
  readonly count: number;
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
  /** Effective source filter applied before projection (when applicable). */
  readonly filter?: EffectiveGraphSourceFilter;
  /** Optional bounded group summaries for the full filtered or visited result set. */
  readonly groups?: readonly GraphGroupSummary[];
}
