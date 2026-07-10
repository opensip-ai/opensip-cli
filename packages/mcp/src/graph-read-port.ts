/**
 * `GraphReadPort` — the narrow async read interface every MCP graph tool
 * handler depends on (ADR-0084 + MCP Graph Audit Phase 1).
 *
 * Every operation returns `Promise<Result<GraphToolResult<T>, McpReadError>>`.
 * A missing catalog is NOT an error — it surfaces as `context.catalog.status
 * === 'missing'` with empty data and no auto-build. Only `refresh` mutates.
 */

import type { McpReadError } from './mcp-error.js';
import type { Freshness, GraphToolResult, SymbolRef } from './symbol-dto.js';
import type { TargetConventionSummary } from '@opensip-cli/contracts';
import type { Result } from '@opensip-cli/core';
import type { GraphSourceFilter, TraversalIdentity } from '@opensip-cli/graph/read';

type GroupByMode = 'none' | 'package' | 'file';
type PackageEdgeKindParam = 'call' | 'import' | 'combined';

/** Identity of the in-memory catalog generation a read was served from. */
export interface GraphGeneration {
  readonly builtAt: string;
  readonly identity: string;
  readonly source?: string;
}

/** A blast-radius score for one symbol (graph's canonical scoring). */
export interface BlastDto {
  readonly symbol: SymbolRef;
  readonly direct: number;
  readonly transitive: number;
  readonly score: number;
  readonly identityMode: 'body-twin-union';
  readonly twinCount?: number;
}

/** One dead-code (orphan) finding projected from `graph:orphan-subtree`. */
export interface DeadCodeDto {
  readonly symbol: SymbolRef;
  readonly message: string;
}

/** Phase 1 traversal snapshot (body-twin walk; Phase 2 widens evidence). */
export interface TraversalSnapshot {
  readonly found: boolean;
  readonly nodes: readonly TraversalNodeDto[];
  readonly path?: readonly SymbolRef[];
  readonly truncated: boolean;
  readonly identityMode: TraversalIdentity;
}

export interface TraversalNodeDto {
  readonly symbol: SymbolRef;
  readonly depth: number;
}

/** Options for {@link GraphReadPort.traverse}. */
export interface TraversalQuery {
  readonly direction: 'callers' | 'callees' | 'path';
  readonly startSymbolId: string;
  readonly goalSymbolId?: string;
  readonly depth?: number;
  readonly identity?: TraversalIdentity;
  readonly filter?: Partial<GraphSourceFilter>;
  readonly limit?: number;
  readonly cursor?: string;
  readonly groupBy?: GroupByMode;
}

/** Labelled node count from graph architecture view. */
export interface LabelledCountDto {
  readonly value: number;
  readonly nodeIdentity: 'occurrence' | 'body-hash';
  readonly sourceScope: string;
  readonly generated: string;
}

/** One package call edge orientation row. */
export interface ArchitecturePackageEdgeDto {
  readonly fromPackage: string;
  readonly toPackage: string;
  readonly kind: 'call';
  readonly count: number;
  readonly countUnit: 'call-sites';
}

/** A compact, labelled architecture overview. */
export interface ArchitectureSummaryDto {
  readonly languages: readonly string[];
  readonly occurrenceCount: LabelledCountDto;
  readonly uniqueBodyCount: LabelledCountDto;
  readonly callEvidence: {
    readonly resolvedCallSites: number;
    readonly resolvedTargets: number;
    readonly unresolvedCallSites: number;
    readonly confidence: Readonly<Record<string, number>>;
    readonly resolution: Readonly<Record<string, number>>;
    readonly edgeKind: 'call';
    readonly catalogResolutionMode: 'exact' | 'fast' | undefined;
  };
  readonly packageCount: number;
  readonly packageEdges: readonly ArchitecturePackageEdgeDto[];
  readonly hotspots: readonly BlastDto[];
  readonly targetConventions?: readonly TargetConventionSummary[];
}

export interface SearchSymbolsOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly match?: 'substring' | 'exact' | 'qualified';
  readonly filter?: Partial<GraphSourceFilter>;
  readonly groupBy?: GroupByMode;
}

export interface DeadCodeQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly filter?: Partial<GraphSourceFilter>;
  readonly groupBy?: GroupByMode;
}

export interface ArchitectureQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly filter?: Partial<GraphSourceFilter>;
  readonly groupBy?: GroupByMode;
}

export interface RefreshResult {
  readonly generation: GraphGeneration;
  readonly action: 'no-op' | 'reloaded' | 'rebuilt';
  readonly durationMs: number;
  readonly priorGenerationAvailable: boolean;
}

export interface CatalogStatus {
  readonly context: GraphToolResult<null>['context'];
  readonly freshness: Freshness;
}

export interface GraphReadPort {
  /** Project/catalog context + freshness without serving query data. */
  catalogStatus(): Promise<Result<CatalogStatus, McpReadError>>;
  /** Resolve a `file:line:col` symbolId to its {@link SymbolRef}. */
  resolveSymbolId(
    symbolId: string,
  ): Promise<Result<GraphToolResult<SymbolRef | undefined>, McpReadError>>;
  /** Search symbols (Phase 1: simple-name substring; Phase 4 widens). */
  searchSymbols(
    query: string,
    opts?: SearchSymbolsOptions,
  ): Promise<Result<GraphToolResult<readonly SymbolRef[]>, McpReadError>>;
  /** All symbols declared in `file` enclosing (or starting at) `line`. */
  findBySpan(
    file: string,
    line: number,
  ): Promise<Result<GraphToolResult<readonly SymbolRef[]>, McpReadError>>;
  /**
   * One-generation traversal (callers/callees/path). Phase 1 exposes the
   * currently shipped body-twin walk; Phase 2 adds occurrence identity.
   */
  traverse(
    query: TraversalQuery,
  ): Promise<Result<GraphToolResult<TraversalSnapshot>, McpReadError>>;
  /** Blast radius of `symbolId` — graph's canonical `buildFeatures` scoring. */
  blast(
    symbolId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<Result<GraphToolResult<BlastDto | undefined>, McpReadError>>;
  /** Orphan (dead-code) symbols via public orphan evaluation. */
  deadCode(
    query?: DeadCodeQuery,
  ): Promise<Result<GraphToolResult<readonly DeadCodeDto[]>, McpReadError>>;
  /** Labelled architecture overview (production/non-generated default). */
  architectureSummary(
    query?: ArchitectureQuery,
  ): Promise<Result<GraphToolResult<ArchitectureSummaryDto>, McpReadError>>;
  /**
   * Sole graph mutation: sync/verify and optionally rebuild.
   * `forceRebuild` skips the no-op/reload short-circuit.
   */
  refresh(opts?: {
    forceRebuild?: boolean;
  }): Promise<Result<GraphToolResult<RefreshResult>, McpReadError>>;
  /** Package call/import dependency rows. */
  packageDependencies(
    query: PackageDependenciesQuery,
  ): Promise<Result<GraphToolResult<PackageDependenciesDto>, McpReadError>>;
  /** Evidence for why package A depends on package B. */
  whyDepends(
    query: WhyDependsQuery,
  ): Promise<Result<GraphToolResult<PackageDependenciesDto>, McpReadError>>;
  /** Package SCCs/cycles for a selected edge kind. */
  packageCycles(
    query: PackageCyclesQuery,
  ): Promise<Result<GraphToolResult<PackageCyclesDto>, McpReadError>>;
}

export interface PackageDependenciesQuery {
  readonly edgeKind?: PackageEdgeKindParam;
  readonly package?: string;
  readonly direction?: 'out' | 'in' | 'both';
  readonly filter?: Partial<GraphSourceFilter>;
  readonly limit?: number;
  readonly cursor?: string;
  readonly groupBy?: GroupByMode;
}

export interface WhyDependsQuery {
  readonly fromPackage: string;
  readonly toPackage: string;
  readonly edgeKind?: PackageEdgeKindParam;
  readonly filter?: Partial<GraphSourceFilter>;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PackageCyclesQuery {
  readonly edgeKind?: PackageEdgeKindParam;
  readonly filter?: Partial<GraphSourceFilter>;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PackageDependenciesDto {
  readonly edgeKind: PackageEdgeKindParam;
  readonly calls: readonly unknown[];
  readonly imports: readonly unknown[];
}

export interface PackageCyclesDto {
  readonly edgeKind: PackageEdgeKindParam;
  readonly components: readonly {
    readonly packages: readonly string[];
    readonly proofEdges: readonly unknown[];
    readonly totalProofEdges: number;
  }[];
}
