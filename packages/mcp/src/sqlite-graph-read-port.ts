/**
 * SQLite-backed {@link GraphReadPort} (ADR-0084).
 *
 * Reads and derives graph data through `@opensip-cli/graph/read`; it never
 * imports graph repositories/rules or raw-queries `DataStore.db`. The generic
 * bounded adjacency walks for callers/callees/trace remain MCP-local.
 *
 * Constructed from an injected `DataStore` (+ optional freshness-context and
 * rebuild providers, wired in Phases 3/4) — it NEVER reads `currentScope()`.
 * Reads return `Result<McpToolResult<T>, McpReadError>`; a missing catalog is
 * NOT an error — it surfaces as `freshness.fresh === false` with empty data and
 * no auto-build. Storage and rebuild failures stay in the Result error arm.
 */

import { err, ok } from '@opensip-cli/core';
import {
  deriveGraphReadFeatures,
  evaluateGraphOrphans,
  loadCatalogGeneration,
  type GraphConfig,
  type ValidationContext,
} from '@opensip-cli/graph/read';

import { createGeneration } from './catalog-generation.js';
import { classifyFreshness, missingFreshness, unverifiedFreshness } from './freshness.js';
import { clampLimit, edgeCount, toDeadCodeDto, toSymbolRef } from './graph-read-projection.js';
import { fromGraphReadError, readError, unexpectedRefreshError } from './mcp-error.js';

import type { CatalogGeneration } from './catalog-generation.js';
import type {
  AdjacencySnapshot,
  ArchitecturePackageDto,
  ArchitectureSummaryDto,
  BlastDto,
  DeadCodeDto,
  GraphGeneration,
  GraphReadPort,
  SearchSymbolsOptions,
} from './graph-read-port.js';
import type { McpReadError } from './mcp-error.js';
import type { Freshness, McpToolResult, SymbolRef } from './symbol-dto.js';
import type { Result } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';
import type { Catalog, FeatureColumn } from '@opensip-cli/graph';

/** Default search-result cap. */
const DEFAULT_SEARCH_LIMIT = 50;
/** Shared empty adjacency for the no-catalog case (avoids per-call allocation). */
const EMPTY_EDGES: ReadonlyMap<string, readonly string[]> = new Map();
/** Default architecture package-row cap. */
const DEFAULT_ARCH_LIMIT = 25;

/** Construction deps — all captured once (no ambient scope reads). */
export interface SqliteGraphReadPortDeps {
  /** The datastore handle the long-lived server captured at construction. */
  readonly store: DataStore;
  /**
   * Build the working-tree {@link ValidationContext} for freshness, given the
   * served generation's catalog (file set + language + adapter cache key). Wired
   * in Phase 4 (`workingTreeContextFromCatalog`); absent ⇒ a loaded catalog is
   * reported `fresh: true` (unverified, matching `graph lookup`).
   */
  readonly freshnessContext?: (catalog: Catalog) => ValidationContext | undefined;
  /**
   * Rebuild the catalog (the `refresh` op). Typed failures and unexpected
   * throws leave the currently served generation untouched.
   */
  readonly rebuild?: () => Promise<Result<Catalog, McpReadError>>;
  /** Graph config used by dead-code / feature evaluation (defaults to `{}`). */
  readonly config?: GraphConfig;
}

export class SqliteGraphReadPort implements GraphReadPort {
  private readonly store: DataStore;
  private readonly config: GraphConfig;
  private generation: CatalogGeneration | undefined;
  private loaded = false;
  /** Bounded load error when public graph/read fails (not a missing catalog). */
  private loadError: McpReadError | undefined;
  // Per-generation memoized derivations (reset on (re)load / refresh). Freshness
  // is deliberately NOT memoized: a long-lived server must re-verify the working
  // tree on each read so a mid-session file mutation flips `fresh` to false.
  private blastCache:
    ReadonlyMap<string, { direct: number; transitive: number; score: number }> | undefined;
  /** In-flight rebuild — serializes concurrent `refresh()` to a single build. */
  private inFlightRefresh:
    Promise<Result<McpToolResult<GraphGeneration>, McpReadError>> | undefined;

  constructor(private readonly deps: SqliteGraphReadPortDeps) {
    this.store = deps.store;
    this.config = deps.config ?? {};
  }

  // ── generation lifecycle ──────────────────────────────────────────

  /** Lazily load + pin the current generation from the persisted catalog. */
  private current(): Result<CatalogGeneration | undefined, McpReadError> {
    if (!this.loaded) {
      try {
        // Public graph/read Result facade — missing catalog is ok(null); storage
        // failures surface as err (mapped via fromGraphReadError). Generation
        // derivation is part of the same boundary because persisted JSON can be
        // parseable while structurally incompatible with the graph indexes.
        const loaded = loadCatalogGeneration(this.store);
        if (loaded.ok) {
          this.loadError = undefined;
          this.generation = loaded.value === null ? undefined : createGeneration(loaded.value);
        } else {
          this.loadError = fromGraphReadError(loaded.error);
          this.generation = undefined;
        }
      } catch {
        this.loadError = readError(
          'GRAPH.READ.CATALOG_GENERATION',
          'Failed to load graph catalog generation',
        );
        this.generation = undefined;
      }
      this.loaded = true;
      this.invalidateDerived();
    }
    if (this.loadError !== undefined) return err(this.loadError);
    return ok(this.generation);
  }

  private invalidateDerived(): void {
    this.blastCache = undefined;
  }

  freshness(): Result<Freshness, McpReadError> {
    const current = this.current();
    if (!current.ok) return current;
    return ok(this.freshnessFor(current.value));
  }

  private freshnessFor(gen: CatalogGeneration | undefined): Freshness {
    return gen === undefined ? missingFreshness() : this.classify(gen);
  }

  private classify(gen: CatalogGeneration): Freshness {
    const ctx = this.deps.freshnessContext?.(gen.catalog);
    if (ctx === undefined) return unverifiedFreshness(gen.builtAt);
    return classifyFreshness(gen.catalog, ctx);
  }

  /** Wrap data in the shared `{ data, freshness, truncated? }` envelope. */
  private wrap<T>(
    data: T,
    gen: CatalogGeneration | undefined,
    truncated?: boolean,
  ): McpToolResult<T> {
    return {
      data,
      freshness: this.freshnessFor(gen),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /** The empty (no-data) envelope for an absent catalog / unresolved symbol. */
  private empty<T>(gen: CatalogGeneration | undefined): McpToolResult<T | undefined> {
    return { data: undefined, freshness: this.freshnessFor(gen) };
  }

  // ── reads ─────────────────────────────────────────────────────────

  getGeneration(): Result<McpToolResult<GraphGeneration | undefined>, McpReadError> {
    const current = this.current();
    if (!current.ok) return current;
    const gen = current.value;
    return ok(this.wrap(gen === undefined ? undefined : { builtAt: gen.builtAt }, gen));
  }

  resolveSymbolId(symbolId: string): Result<McpToolResult<SymbolRef | undefined>, McpReadError> {
    const current = this.current();
    if (!current.ok) return current;
    const gen = current.value;
    if (gen === undefined) return ok(this.empty<SymbolRef>(gen));
    const occ = gen.indexes.byOccId.get(symbolId);
    return ok(this.wrap(occ === undefined ? undefined : toSymbolRef(occ), gen));
  }

  searchSymbols(
    query: string,
    opts?: SearchSymbolsOptions,
  ): Result<McpToolResult<readonly SymbolRef[]>, McpReadError> {
    const current = this.current();
    if (!current.ok) return current;
    const gen = current.value;
    if (gen === undefined) return ok(this.wrap([] as readonly SymbolRef[], gen));
    const limit = clampLimit(opts?.limit, DEFAULT_SEARCH_LIMIT);
    const needle = query.toLowerCase();
    const matches: SymbolRef[] = [];
    let truncated = false;
    for (const occ of gen.indexes.byOccId.values()) {
      if (occ.kind === 'module-init') continue;
      if (!occ.simpleName.toLowerCase().includes(needle)) continue;
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
      matches.push(toSymbolRef(occ));
    }
    return ok(this.wrap(matches, gen, truncated));
  }

  findBySpan(
    file: string,
    line: number,
  ): Result<McpToolResult<readonly SymbolRef[]>, McpReadError> {
    const current = this.current();
    if (!current.ok) return current;
    const gen = current.value;
    if (gen === undefined) return ok(this.wrap([] as readonly SymbolRef[], gen));
    const out: SymbolRef[] = [];
    for (const occ of gen.indexes.byOccId.values()) {
      if (occ.filePath === file && occ.line <= line && line <= occ.endLine) {
        out.push(toSymbolRef(occ));
      }
    }
    return ok(this.wrap(out, gen));
  }

  callerGraph(): Result<McpToolResult<AdjacencySnapshot>, McpReadError> {
    return this.adjacencyGraph('callers');
  }

  calleeGraph(): Result<McpToolResult<AdjacencySnapshot>, McpReadError> {
    return this.adjacencyGraph('callees');
  }

  /** Read one direction's adjacency through the shared generation boundary. */
  private adjacencyGraph(
    direction: 'callers' | 'callees',
  ): Result<McpToolResult<AdjacencySnapshot>, McpReadError> {
    const current = this.current();
    if (!current.ok) return current;
    return ok(this.wrap(this.adjacency(current.value, direction), current.value));
  }

  /**
   * Project one direction's body-hash adjacency into a walkable
   * {@link AdjacencySnapshot}. The map IS the engine's `Indexes.callers`/
   * `callees` (no copy); the resolver closes over `byBodyHash`. The bounded
   * walk itself lives in MCP's `boundedBfs` (rule of three) — the port never
   * re-implements a BFS.
   */
  private adjacency(
    gen: CatalogGeneration | undefined,
    direction: 'callers' | 'callees',
  ): AdjacencySnapshot {
    const edges = gen === undefined ? EMPTY_EDGES : gen.indexes[direction];
    const byBodyHash = gen?.indexes.byBodyHash;
    return {
      edges,
      resolve: (bodyHash) => {
        const occ = byBodyHash?.get(bodyHash);
        return occ === undefined ? undefined : toSymbolRef(occ);
      },
    };
  }

  blast(symbolId: string): Result<McpToolResult<BlastDto | undefined>, McpReadError> {
    const current = this.current();
    if (!current.ok) return current;
    const gen = current.value;
    if (gen === undefined) return ok(this.empty<BlastDto>(gen));
    const occ = gen.indexes.byOccId.get(symbolId);
    if (occ === undefined) return ok(this.empty<BlastDto>(gen));
    const score = this.blastScores(gen).get(occ.bodyHash);
    if (score === undefined) return ok(this.empty<BlastDto>(gen));
    return ok(this.wrap({ symbol: toSymbolRef(occ), ...score }, gen));
  }

  /** Memoized blast table — the canonical `buildFeatures(['blast'])` scoring. */
  private blastScores(
    gen: CatalogGeneration,
  ): ReadonlyMap<string, { direct: number; transitive: number; score: number }> {
    if (this.blastCache !== undefined) return this.blastCache;
    const columns: readonly FeatureColumn[] = ['blast'];
    const features = deriveGraphReadFeatures(gen.catalog, gen.indexes, this.config, columns);
    const out = new Map<string, { direct: number; transitive: number; score: number }>();
    for (const [hash, row] of features.function) {
      if (row.blast !== undefined) {
        out.set(hash, {
          direct: row.blast.direct,
          transitive: row.blast.transitive,
          score: row.blast.score,
        });
      }
    }
    this.blastCache = out;
    return out;
  }

  deadCode(limit?: number): Result<McpToolResult<readonly DeadCodeDto[]>, McpReadError> {
    const current = this.current();
    if (!current.ok) return current;
    const gen = current.value;
    if (gen === undefined) return ok(this.wrap([] as readonly DeadCodeDto[], gen));
    const columns: readonly FeatureColumn[] = ['reachableFromEntry'];
    const features = deriveGraphReadFeatures(gen.catalog, gen.indexes, this.config, columns);
    const signals = evaluateGraphOrphans(gen.catalog, gen.indexes, this.config, features);
    const entries: DeadCodeDto[] = [];
    let truncated = false;
    for (const signal of signals) {
      if (limit !== undefined && entries.length >= limit) {
        truncated = true;
        break;
      }
      const dto = toDeadCodeDto(signal, gen.indexes);
      if (dto !== undefined) entries.push(dto);
    }
    return ok(this.wrap(entries, gen, truncated));
  }

  architectureSummary(limit?: number): Result<McpToolResult<ArchitectureSummaryDto>, McpReadError> {
    const current = this.current();
    if (!current.ok) return current;
    const gen = current.value;
    if (gen === undefined) {
      return ok(
        this.wrap(
          {
            functionCount: 0,
            edgeCount: 0,
            languages: [],
            packages: [],
            hotspots: [],
          },
          gen,
        ),
      );
    }
    const columns: readonly FeatureColumn[] = ['packageCoupling'];
    const features = deriveGraphReadFeatures(gen.catalog, gen.indexes, this.config, columns);
    const cap = clampLimit(limit, DEFAULT_ARCH_LIMIT);
    const rows: ArchitecturePackageDto[] = [];
    for (const [name, row] of features.package) {
      rows.push({
        name,
        couplingOut: row.couplingOut,
        couplingIn: row.couplingIn,
      });
    }
    rows.sort((a, b) => b.couplingOut + b.couplingIn - (a.couplingOut + a.couplingIn));
    const packages = rows.slice(0, cap);
    const hotspots = this.topHotspots(gen, cap);
    return ok(
      this.wrap(
        {
          functionCount: gen.indexes.byBodyHash.size,
          edgeCount: edgeCount(gen.indexes),
          languages: [gen.catalog.language],
          packages,
          hotspots,
        },
        gen,
        packages.length < rows.length,
      ),
    );
  }

  /** The `cap` highest-blast symbols (graph's canonical scoring; reused, not reinvented). */
  private topHotspots(gen: CatalogGeneration, cap: number): BlastDto[] {
    const scores = this.blastScores(gen);
    const ranked: BlastDto[] = [];
    for (const [hash, score] of scores) {
      const occ = gen.indexes.byBodyHash.get(hash);
      if (occ !== undefined) ranked.push({ symbol: toSymbolRef(occ), ...score });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, cap);
  }

  async refresh(): Promise<Result<McpToolResult<GraphGeneration>, McpReadError>> {
    const rebuild = this.deps.rebuild;
    if (rebuild === undefined) {
      return err(
        readError(
          'refresh-unavailable',
          'graph refresh is not wired (the rebuild provider is supplied by the host command).',
        ),
      );
    }
    // Serialize concurrent refreshes to ONE rebuild: a second caller awaits the
    // in-flight build rather than launching a duplicate. In-flight reads keep the
    // prior generation until the swap completes (TOCTOU-safe; catalog-generation.ts).
    this.inFlightRefresh ??= this.runRebuild(rebuild);
    try {
      return await this.inFlightRefresh;
    } finally {
      this.inFlightRefresh = undefined;
    }
  }

  /** One rebuild: runs the provider, then swaps the generation atomically on success. */
  private async runRebuild(
    rebuild: () => Promise<Result<Catalog, McpReadError>>,
  ): Promise<Result<McpToolResult<GraphGeneration>, McpReadError>> {
    try {
      const rebuilt = await rebuild();
      if (!rebuilt.ok) return rebuilt;
      const next = createGeneration(rebuilt.value);
      this.generation = next;
      this.loadError = undefined;
      this.loaded = true;
      this.invalidateDerived();
      return ok(this.wrap({ builtAt: next.builtAt }, next));
    } catch {
      return err(unexpectedRefreshError());
    }
  }
}
