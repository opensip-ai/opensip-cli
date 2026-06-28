/**
 * `GraphReadPort` — the narrow read interface every MCP graph tool handler
 * depends on (ADR-0084). Handlers NEVER touch `CatalogRepo` / `Indexes`
 * directly; they go through this port. Two named benefits justify the boundary:
 *   1. **Test seam** — handlers are unit-tested against an in-memory fake port,
 *      no SQLite needed (Phase 6).
 *   2. **Compile-time SaaS parity** — a handler cannot reach the storage layer,
 *      so an alternate (cloud) backend can substitute behind the same interface.
 *
 * Every read returns `Result<McpToolResult<T>, McpReadError>` (ADR-0084): the
 * success arm carries `{ data, freshness }`; `throw` is reserved for the
 * SQLite/Drizzle boundary inside the impl. A missing catalog is NOT an error —
 * it surfaces as `freshness.fresh === false` with empty data and no auto-build.
 */

import type { McpReadError } from './mcp-error.js';
import type { Freshness, McpToolResult, SymbolRef } from './symbol-dto.js';
import type { Result } from '@opensip-cli/core';

/** Identity of the in-memory catalog generation a read was served from. */
export interface GraphGeneration {
  /** ISO timestamp the served generation's catalog was built at. */
  readonly builtAt: string;
}

/** A blast-radius score for one symbol (graph's canonical scoring — reused, not reinvented). */
export interface BlastDto {
  readonly symbol: SymbolRef;
  /** Direct (depth-1) caller count. */
  readonly direct: number;
  /** Transitive (depth 2..5) caller count. */
  readonly transitive: number;
  /** `direct + 0.5 × transitive`. */
  readonly score: number;
}

/** One dead-code (orphan) finding projected from `graph:orphan-subtree`. */
export interface DeadCodeDto {
  readonly symbol: SymbolRef;
  /** The rule's human-readable message. */
  readonly message: string;
}

/** The outcome of {@link GraphReadPort.tracePath}: an ordered symbol chain. */
export interface PathTraceDto {
  /** `true` when a call path `from → … → to` exists within the depth bound. */
  readonly found: boolean;
  /** The ordered path (empty when not found). */
  readonly path: readonly SymbolRef[];
}

/** One package-coupling row in the architecture summary. */
export interface ArchitecturePackageDto {
  readonly name: string;
  /** Distinct callee packages this package depends on. */
  readonly couplingOut: number;
  /** Distinct caller packages that depend on this one. */
  readonly couplingIn: number;
}

/** A compact architecture overview: node/edge counts + top-coupled packages. */
export interface ArchitectureSummaryDto {
  readonly functionCount: number;
  readonly edgeCount: number;
  readonly packages: readonly ArchitecturePackageDto[];
}

/** Options for {@link GraphReadPort.searchSymbols}. */
export interface SearchSymbolsOptions {
  /** Max results before truncation (handler-clamped; impl applies a default). */
  readonly limit?: number;
}

export interface GraphReadPort {
  /** Identity of the current generation (`undefined` when no catalog is loaded). */
  getGeneration(): Result<McpToolResult<GraphGeneration | undefined>, McpReadError>;
  /** Resolve a `file:line:col` symbolId to its {@link SymbolRef}. */
  resolveSymbolId(symbolId: string): Result<McpToolResult<SymbolRef | undefined>, McpReadError>;
  /** Search symbols by simple name (substring, case-insensitive). */
  searchSymbols(
    query: string,
    opts?: SearchSymbolsOptions,
  ): Result<McpToolResult<readonly SymbolRef[]>, McpReadError>;
  /** All symbols declared in `file` enclosing (or starting at) `line`. */
  findBySpan(file: string, line: number): Result<McpToolResult<readonly SymbolRef[]>, McpReadError>;
  /** Bounded reverse walk: who calls `symbolId`, out to `depth` (≤ 5). */
  callersOf(
    symbolId: string,
    depth: number,
  ): Result<McpToolResult<readonly SymbolRef[]>, McpReadError>;
  /** Bounded forward walk: what `symbolId` calls, out to `depth` (≤ 5). */
  calleesOf(
    symbolId: string,
    depth: number,
  ): Result<McpToolResult<readonly SymbolRef[]>, McpReadError>;
  /** Shortest call path `from → to` within the depth bound. */
  tracePath(from: string, to: string): Result<McpToolResult<PathTraceDto>, McpReadError>;
  /** Blast radius of `symbolId` — graph's canonical `buildFeatures` scoring. */
  blast(symbolId: string): Result<McpToolResult<BlastDto | undefined>, McpReadError>;
  /** Orphan (dead-code) symbols via `graph:orphan-subtree` (no filesystem reads). */
  deadCode(limit?: number): Result<McpToolResult<readonly DeadCodeDto[]>, McpReadError>;
  /** Package-coupling architecture overview. */
  architectureSummary(limit?: number): Result<McpToolResult<ArchitectureSummaryDto>, McpReadError>;
  /**
   * Rebuild the catalog (the single state-changing op) and swap the generation
   * atomically. Async — runs the graph programmatic build at a genuine infra
   * boundary. Wired in Phase 4.
   */
  refresh(): Promise<Result<McpToolResult<GraphGeneration>, McpReadError>>;
  /** The current freshness verdict (read without serving data). */
  freshness(): Freshness;
}
