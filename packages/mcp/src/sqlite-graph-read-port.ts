/**
 * SQLite-backed {@link GraphReadPort} (ADR-0084).
 *
 * Reads the persisted catalog through the graph engine's `CatalogRepo`
 * (internal surface) and derives adjacency via `buildIndexes` — it NEVER invents
 * a parallel catalog table or raw-queries `DataStore.db`. Freshness reuses
 * `classifyCatalog`; dead code reuses `orphanSubtreeRule`; blast reuses the
 * single canonical `buildFeatures(['blast'])` scoring site (no ad-hoc BFS). The
 * generic bounded adjacency walks for callers/callees/trace are MCP-local.
 *
 * Constructed from an injected `DataStore` (+ optional freshness-context and
 * rebuild providers, wired in Phases 3/4) — it NEVER reads `currentScope()`.
 * Reads return `Result<McpToolResult<T>, McpReadError>`; a missing catalog is
 * NOT an error — it surfaces as `freshness.fresh === false` with empty data and
 * no auto-build. `throw` is reserved for the SQLite/Drizzle boundary (a failing
 * `CatalogRepo.loadFullCatalog`) and the `runGraph` rebuild.
 */

import { err, ok } from '@opensip-cli/core';
import { buildFeatures, CatalogRepo, orphanSubtreeRule } from '@opensip-cli/graph/internal';

import { createGeneration } from './catalog-generation.js';
import { classifyFreshness, missingFreshness, unverifiedFreshness } from './freshness.js';
import { readError } from './mcp-error.js';

import type { CatalogGeneration } from './catalog-generation.js';
import type {
  ArchitecturePackageDto,
  ArchitectureSummaryDto,
  BlastDto,
  DeadCodeDto,
  GraphGeneration,
  GraphReadPort,
  PathTraceDto,
  SearchSymbolsOptions,
} from './graph-read-port.js';
import type { McpReadError } from './mcp-error.js';
import type { Freshness, McpToolResult, SymbolRef } from './symbol-dto.js';
import type { Result, Signal } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';
import type { Catalog, FeatureColumn, FunctionOccurrence, Indexes } from '@opensip-cli/graph';
import type { GraphConfig, ValidationContext } from '@opensip-cli/graph/internal';

/** Hard depth cap on bounded adjacency walks (bounds memory; ADR-0084 §Hardening). */
const MAX_DEPTH = 5;
/** Hard node cap on a single walk before `truncated` is set. */
const MAX_WALK_NODES = 2000;
/** Default search-result cap. */
const DEFAULT_SEARCH_LIMIT = 50;
/** Default architecture package-row cap. */
const DEFAULT_ARCH_LIMIT = 25;

/** Construction deps — all captured once (no ambient scope reads). */
export interface SqliteGraphReadPortDeps {
  /** The datastore handle the long-lived server captured at construction. */
  readonly store: DataStore;
  /**
   * Build the current working-tree {@link ValidationContext} for freshness
   * (file set + adapter cache key). Wired in Phase 3; absent ⇒ a loaded catalog
   * is reported `fresh: true` (unverified, matching `graph lookup`).
   */
  readonly freshnessContext?: () => ValidationContext | undefined;
  /**
   * Rebuild the catalog (the `refresh` op) and return the new {@link Catalog}.
   * Wired in Phase 4; absent ⇒ `refresh()` returns a structured error.
   */
  readonly rebuild?: () => Promise<Catalog>;
  /** Graph config used by dead-code / feature evaluation (defaults to `{}`). */
  readonly config?: GraphConfig;
}

export class SqliteGraphReadPort implements GraphReadPort {
  private readonly store: DataStore;
  private readonly config: GraphConfig;
  private generation: CatalogGeneration | undefined;
  private loaded = false;
  // Per-generation memoized derivations (reset on (re)load / refresh).
  private freshnessCache: Freshness | undefined;
  private blastCache:
    | ReadonlyMap<string, { direct: number; transitive: number; score: number }>
    | undefined;

  constructor(private readonly deps: SqliteGraphReadPortDeps) {
    this.store = deps.store;
    this.config = deps.config ?? {};
  }

  // ── generation lifecycle ──────────────────────────────────────────

  /** Lazily load + pin the current generation from the persisted catalog. */
  private current(): CatalogGeneration | undefined {
    if (!this.loaded) {
      // CatalogRepo throws only on a genuine SQLite/Drizzle failure (sanctioned
      // infra boundary); a missing catalog returns null → no generation.
      const catalog = new CatalogRepo(this.store).loadFullCatalog();
      this.generation = catalog === null ? undefined : createGeneration(catalog);
      this.loaded = true;
      this.invalidateDerived();
    }
    return this.generation;
  }

  private invalidateDerived(): void {
    this.freshnessCache = undefined;
    this.blastCache = undefined;
  }

  freshness(): Freshness {
    if (this.freshnessCache !== undefined) return this.freshnessCache;
    const gen = this.current();
    this.freshnessCache = gen === undefined ? missingFreshness() : this.classify(gen);
    return this.freshnessCache;
  }

  private classify(gen: CatalogGeneration): Freshness {
    const ctx = this.deps.freshnessContext?.();
    if (ctx === undefined) return unverifiedFreshness(gen.builtAt);
    return classifyFreshness(gen.catalog, ctx);
  }

  /** Wrap data in the shared `{ data, freshness, truncated? }` envelope. */
  private wrap<T>(data: T, truncated?: boolean): McpToolResult<T> {
    return {
      data,
      freshness: this.freshness(),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /** The empty (no-data) envelope for an absent catalog / unresolved symbol. */
  private empty<T>(): McpToolResult<T | undefined> {
    return { data: undefined, freshness: this.freshness() };
  }

  // ── reads ─────────────────────────────────────────────────────────

  getGeneration(): Result<McpToolResult<GraphGeneration | undefined>, McpReadError> {
    const gen = this.current();
    return ok(this.wrap(gen === undefined ? undefined : { builtAt: gen.builtAt }));
  }

  resolveSymbolId(symbolId: string): Result<McpToolResult<SymbolRef | undefined>, McpReadError> {
    const gen = this.current();
    if (gen === undefined) return ok(this.empty<SymbolRef>());
    const occ = gen.indexes.byOccId.get(symbolId);
    return ok(this.wrap(occ === undefined ? undefined : toSymbolRef(occ)));
  }

  searchSymbols(
    query: string,
    opts?: SearchSymbolsOptions,
  ): Result<McpToolResult<readonly SymbolRef[]>, McpReadError> {
    const gen = this.current();
    if (gen === undefined) return ok(this.wrap([] as readonly SymbolRef[]));
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
    return ok(this.wrap(matches, truncated));
  }

  findBySpan(
    file: string,
    line: number,
  ): Result<McpToolResult<readonly SymbolRef[]>, McpReadError> {
    const gen = this.current();
    if (gen === undefined) return ok(this.wrap([] as readonly SymbolRef[]));
    const out: SymbolRef[] = [];
    for (const occ of gen.indexes.byOccId.values()) {
      if (occ.filePath === file && occ.line <= line && line <= occ.endLine) {
        out.push(toSymbolRef(occ));
      }
    }
    return ok(this.wrap(out));
  }

  callersOf(
    symbolId: string,
    depth: number,
  ): Result<McpToolResult<readonly SymbolRef[]>, McpReadError> {
    return this.walkFrom(symbolId, depth, (gen) => gen.indexes.callers);
  }

  calleesOf(
    symbolId: string,
    depth: number,
  ): Result<McpToolResult<readonly SymbolRef[]>, McpReadError> {
    return this.walkFrom(symbolId, depth, (gen) => gen.indexes.callees);
  }

  private walkFrom(
    symbolId: string,
    depth: number,
    pick: (gen: CatalogGeneration) => ReadonlyMap<string, readonly string[]>,
  ): Result<McpToolResult<readonly SymbolRef[]>, McpReadError> {
    const gen = this.current();
    if (gen === undefined) return ok(this.wrap([] as readonly SymbolRef[]));
    const start = gen.indexes.byOccId.get(symbolId);
    if (start === undefined) return ok(this.wrap([] as readonly SymbolRef[]));
    const walk = boundedWalk(start.bodyHash, pick(gen), depth);
    const refs = hashesToRefs(walk.hashes, gen.indexes);
    return ok(this.wrap(refs, walk.truncated));
  }

  tracePath(from: string, to: string): Result<McpToolResult<PathTraceDto>, McpReadError> {
    const gen = this.current();
    if (gen === undefined) return ok(this.wrap({ found: false, path: [] }));
    const start = gen.indexes.byOccId.get(from);
    const goal = gen.indexes.byOccId.get(to);
    if (start === undefined || goal === undefined) {
      return ok(this.wrap({ found: false, path: [] }));
    }
    const hashes = tracePathHashes(start.bodyHash, goal.bodyHash, gen.indexes);
    if (hashes === undefined) return ok(this.wrap({ found: false, path: [] }));
    return ok(this.wrap({ found: true, path: hashesToRefs(hashes, gen.indexes) }));
  }

  blast(symbolId: string): Result<McpToolResult<BlastDto | undefined>, McpReadError> {
    const gen = this.current();
    if (gen === undefined) return ok(this.empty<BlastDto>());
    const occ = gen.indexes.byOccId.get(symbolId);
    if (occ === undefined) return ok(this.empty<BlastDto>());
    const score = this.blastScores(gen).get(occ.bodyHash);
    if (score === undefined) return ok(this.empty<BlastDto>());
    return ok(this.wrap({ symbol: toSymbolRef(occ), ...score }));
  }

  /** Memoized blast table — the canonical `buildFeatures(['blast'])` scoring. */
  private blastScores(
    gen: CatalogGeneration,
  ): ReadonlyMap<string, { direct: number; transitive: number; score: number }> {
    if (this.blastCache !== undefined) return this.blastCache;
    const columns: readonly FeatureColumn[] = ['blast'];
    const features = buildFeatures(gen.catalog, gen.indexes, this.config, columns);
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
    const gen = this.current();
    if (gen === undefined) return ok(this.wrap([] as readonly DeadCodeDto[]));
    const columns: readonly FeatureColumn[] = ['reachableFromEntry'];
    const features = buildFeatures(gen.catalog, gen.indexes, this.config, columns);
    const signals = orphanSubtreeRule.evaluate(
      gen.catalog,
      gen.indexes,
      this.config,
      undefined,
      features,
    );
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
    return ok(this.wrap(entries, truncated));
  }

  architectureSummary(limit?: number): Result<McpToolResult<ArchitectureSummaryDto>, McpReadError> {
    const gen = this.current();
    if (gen === undefined) {
      return ok(this.wrap({ functionCount: 0, edgeCount: 0, packages: [] }));
    }
    const columns: readonly FeatureColumn[] = ['packageCoupling'];
    const features = buildFeatures(gen.catalog, gen.indexes, this.config, columns);
    const cap = clampLimit(limit, DEFAULT_ARCH_LIMIT);
    const rows: ArchitecturePackageDto[] = [];
    for (const [name, row] of features.package) {
      rows.push({ name, couplingOut: row.couplingOut, couplingIn: row.couplingIn });
    }
    rows.sort((a, b) => b.couplingOut + b.couplingIn - (a.couplingOut + a.couplingIn));
    const packages = rows.slice(0, cap);
    return ok(
      this.wrap(
        {
          functionCount: gen.indexes.byBodyHash.size,
          edgeCount: edgeCount(gen.indexes),
          packages,
        },
        packages.length < rows.length,
      ),
    );
  }

  async refresh(): Promise<Result<McpToolResult<GraphGeneration>, McpReadError>> {
    if (this.deps.rebuild === undefined) {
      return err(
        readError(
          'refresh-unavailable',
          'graph refresh is not wired (the rebuild provider is supplied in Phase 4).',
        ),
      );
    }
    // The rebuild runs `runGraph` at a genuine infra boundary; its throw (child
    // build failure) propagates. On success, swap the generation atomically.
    const catalog = await this.deps.rebuild();
    this.generation = createGeneration(catalog);
    this.loaded = true;
    this.invalidateDerived();
    return ok(this.wrap({ builtAt: this.generation.builtAt }));
  }
}

// ── pure helpers ────────────────────────────────────────────────────

function toSymbolRef(occ: FunctionOccurrence): SymbolRef {
  return {
    symbolId: `${occ.filePath}:${String(occ.line)}:${String(occ.column)}`,
    bodyHash: occ.bodyHash,
    qualifiedName: occ.qualifiedName,
    filePath: occ.filePath,
    line: occ.line,
    column: occ.column,
    kind: occ.kind,
    visibility: occ.visibility,
  };
}

/** Resolve body hashes to `SymbolRef`s (skipping any that no longer resolve). */
function hashesToRefs(hashes: readonly string[], indexes: Indexes): SymbolRef[] {
  const refs: SymbolRef[] = [];
  for (const hash of hashes) {
    const occ = indexes.byBodyHash.get(hash);
    if (occ !== undefined) refs.push(toSymbolRef(occ));
  }
  return refs;
}

/** Bounded BFS over an adjacency map from a start body hash (depth-/node-capped). */
function boundedWalk(
  start: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  depth: number,
): { hashes: string[]; truncated: boolean } {
  const maxDepth = Math.min(Math.max(Math.trunc(depth), 1), MAX_DEPTH);
  const visited = new Set<string>([start]);
  const out: string[] = [];
  let frontier: string[] = [start];
  for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
    const step = expandFrontier(frontier, adjacency, visited, out);
    if (step.truncated) return { hashes: out, truncated: true };
    frontier = step.next;
  }
  return { hashes: out, truncated: false };
}

/** Expand one BFS frontier, appending newly-seen neighbors (node-capped). */
function expandFrontier(
  frontier: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  visited: Set<string>,
  out: string[],
): { next: string[]; truncated: boolean } {
  const next: string[] = [];
  for (const node of frontier) {
    for (const neighbor of adjacency.get(node) ?? []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      if (out.length >= MAX_WALK_NODES) return { next, truncated: true };
      out.push(neighbor);
      next.push(neighbor);
    }
  }
  return { next, truncated: false };
}

/** Shortest call path `from → to` over `callees`, within the depth bound. */
function tracePathHashes(fromHash: string, toHash: string, indexes: Indexes): string[] | undefined {
  if (fromHash === toHash) return [fromHash];
  const parent = new Map<string, string>();
  const visited = new Set<string>([fromHash]);
  let frontier: string[] = [fromHash];
  for (let d = 0; d < MAX_DEPTH && frontier.length > 0; d++) {
    const step = traceFrontier(frontier, indexes, visited, parent, toHash);
    if (step.found) return reconstructPath(parent, fromHash, toHash);
    frontier = step.next;
  }
  return undefined;
}

/** Expand one trace frontier; returns `found` the moment `toHash` is reached. */
function traceFrontier(
  frontier: readonly string[],
  indexes: Indexes,
  visited: Set<string>,
  parent: Map<string, string>,
  toHash: string,
): { next: string[]; found: boolean } {
  const next: string[] = [];
  for (const node of frontier) {
    for (const neighbor of indexes.callees.get(node) ?? []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      parent.set(neighbor, node);
      if (neighbor === toHash) return { next, found: true };
      next.push(neighbor);
    }
  }
  return { next, found: false };
}

/** Rebuild the path `from → … → to` from a parent map (built front-to-back). */
function reconstructPath(
  parent: ReadonlyMap<string, string>,
  fromHash: string,
  toHash: string,
): string[] {
  const path: string[] = [];
  let cursor: string | undefined = toHash;
  while (cursor !== undefined) {
    path.unshift(cursor);
    if (cursor === fromHash) break;
    cursor = parent.get(cursor);
  }
  return path;
}

/** Map an `graph:orphan-subtree` signal to a {@link DeadCodeDto} (no FS reads). */
function toDeadCodeDto(signal: Signal, indexes: Indexes): DeadCodeDto | undefined {
  const code = signal.code;
  if (code?.file === undefined || code.line === undefined || code.column === undefined) {
    return undefined;
  }
  const occ = indexes.byOccId.get(`${code.file}:${String(code.line)}:${String(code.column)}`);
  if (occ === undefined) return undefined;
  return { symbol: toSymbolRef(occ), message: signal.message };
}

/** Total out-edge count across the callees adjacency. */
function edgeCount(indexes: Indexes): number {
  let total = 0;
  for (const targets of indexes.callees.values()) total += targets.length;
  return total;
}

/** Clamp a caller-supplied limit to a positive integer, defaulting when absent. */
function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.trunc(limit);
}
