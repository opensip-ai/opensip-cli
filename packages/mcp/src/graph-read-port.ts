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
import type { Result } from '@opensip-cli/core';
import type {
  ArchitectureHotspot,
  ArchitecturePackageEdgeRow,
  CallEdgeEvidence,
  CallEvidenceMetrics,
  LabelledNodeCount,
  LabelledPackageCount,
  PackageCallEvidence,
  PackageCallEvidenceRow,
  PackageCycleProofEdge,
  PackageImportEvidence,
  PackageImportEvidenceRow,
  GraphSourceFilter,
  TraversalIdentity,
} from '@opensip-cli/graph/read';

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
  readonly members: readonly SymbolRef[];
  readonly totalMembership: number;
  readonly direct: number;
  readonly transitive: number;
  readonly score: number;
  readonly identityMode: 'body-twin-union';
  readonly twinCount?: number;
  readonly filteringLimitations?: readonly string[];
}

/** One dead-code (orphan) finding projected from `graph:orphan-subtree`. */
export interface DeadCodeDto {
  readonly symbol: SymbolRef;
  readonly message: string;
  readonly ruleId: 'graph:orphan-subtree';
  readonly reason: 'unreachable-from-inferred-entry-point';
  readonly suggestion?: string;
}

/** Phase 1 traversal snapshot (body-twin walk; Phase 2 widens evidence). */
export interface TraversalSnapshot {
  readonly found: boolean;
  readonly nodes: readonly TraversalNodeDto[];
  readonly path?: readonly SymbolRef[];
  readonly hops?: readonly TraversalHopDto[];
  readonly weakestConfidence?: CallEdgeEvidence['confidence'];
  readonly identityMode: TraversalIdentity;
  readonly totalMembership: number;
  readonly counts: {
    readonly includedOccurrences: number;
    readonly excludedOccurrences: number;
    readonly includedEdges: number;
    readonly excludedEdges: number;
    readonly countScope: 'visited';
  };
  readonly unresolved: readonly {
    readonly ownerSymbolId: string;
    readonly resolution: string;
    readonly confidence: string;
    readonly callSite: {
      readonly filePath: string;
      readonly line: number;
      readonly column: number;
    };
    readonly targetHashes: readonly string[];
    readonly totalTargetHashes: number;
  }[];
  readonly unresolvedCounts: readonly {
    readonly resolution: string;
    readonly confidence: string;
    readonly count: number;
  }[];
  readonly unresolvedAttribution: 'owner-only';
}

export interface TraversalNodeDto {
  readonly symbol: SymbolRef;
  readonly depth: number;
  readonly groupId: string;
  readonly groupTotal: number;
  readonly incomingEvidence?: CallEdgeEvidence;
  readonly anyTwinMaySupplyHop?: boolean;
}

export interface TraversalHopDto {
  readonly fromGroupId: string;
  readonly toGroupId: string;
  readonly evidence: readonly CallEdgeEvidence[];
  readonly weakestConfidence?: CallEdgeEvidence['confidence'];
  readonly anyTwinMaySupplyHop: boolean;
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

/** A compact, labelled architecture overview. */
export interface ArchitectureSummaryDto {
  readonly languages: readonly string[];
  readonly occurrenceCount: LabelledNodeCount;
  readonly uniqueBodyCount: LabelledNodeCount;
  readonly callEvidence: CallEvidenceMetrics;
  readonly packageCount: LabelledPackageCount;
  readonly packageEdges: readonly ArchitecturePackageEdgeRow[];
  readonly hotspots: readonly ArchitectureHotspot[];
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
    opts?: {
      limit?: number;
      cursor?: string;
      filter?: Partial<GraphSourceFilter>;
      groupBy?: GroupByMode;
    },
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
  whyDepends(query: WhyDependsQuery): Promise<Result<GraphToolResult<WhyDependsDto>, McpReadError>>;
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
  readonly groupBy?: GroupByMode;
}

export interface PackageCyclesQuery {
  readonly edgeKind?: PackageEdgeKindParam;
  readonly filter?: Partial<GraphSourceFilter>;
  readonly limit?: number;
  readonly cursor?: string;
  readonly groupBy?: GroupByMode;
}

export interface PackageDependenciesDto {
  readonly edgeKind: PackageEdgeKindParam;
  readonly calls: readonly PackageCallEvidenceRow[];
  readonly imports: readonly PackageImportEvidenceRow[];
}

export interface WhyDependsDto {
  readonly edgeKind: PackageEdgeKindParam;
  readonly calls: readonly PackageCallEvidence[];
  readonly imports: readonly PackageImportEvidence[];
  readonly totalMatchingEvidence: number;
}

export interface PackageCyclesDto {
  readonly edgeKind: PackageEdgeKindParam;
  readonly components: readonly {
    readonly packages: readonly string[];
    readonly proofEdges: readonly PackageCycleProofEdge[];
    readonly totalProofEdges: number;
  }[];
}
