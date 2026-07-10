/**
 * SQLite-backed {@link GraphReadPort} (ADR-0084 + MCP Graph Audit Phase 1).
 *
 * Composes {@link GraphGenerationController} for lifecycle and owns query
 * projection + evidence-envelope assembly. Passes the injected datastore only
 * to public graph/read functions — never accesses `.db` or graph persistence.
 */

import { ephemeralProjectCacheKey, err, ok, type Result } from '@opensip-cli/core';
import {
  buildArchitectureView,
  buildOccurrenceCallView,
  buildPackageEvidence,
  buildPackageScc,
  deriveGraphReadFeatures,
  evaluateGraphOrphans,
  hotspotStableKey,
  loadCatalogGeneration,
  matchesGraphSourceFilter,
  packageEdgeStableKey,
  readCatalogIdentity,
  searchSymbolOccurrences,
  symbolSearchStableKey,
  verifyCatalogInputs,
  type GraphAdapterRegistryReader,
  type GraphConfig,
  type GraphSourceFilter,
} from '@opensip-cli/graph/read';

import { GraphGenerationController, type CatalogGeneration } from './catalog-generation.js';
import { freshnessFromVerification, missingFreshness } from './freshness.js';
import {
  bindCursor,
  decodeCursor,
  digestNormalizedQuery,
  encodeCursor,
  groupRows,
  type GroupSummary,
} from './graph-query-page.js';
import { clampLimit, toDeadCodeDto, toSymbolRef } from './graph-read-projection.js';
import { fromGraphReadError, readError } from './mcp-error.js';
import { boundedBfs, reconstructPath } from './tools/graph-walk.js';

import type {
  ArchitectureQuery,
  ArchitectureSummaryDto,
  BlastDto,
  CatalogStatus,
  DeadCodeDto,
  DeadCodeQuery,
  GraphReadPort,
  PackageCyclesDto,
  PackageCyclesQuery,
  PackageDependenciesDto,
  PackageDependenciesQuery,
  RefreshResult,
  SearchSymbolsOptions,
  TraversalQuery,
  TraversalSnapshot,
  WhyDependsQuery,
} from './graph-read-port.js';
import type { McpReadError } from './mcp-error.js';
import type {
  Freshness,
  GraphCoverage,
  GraphEvidenceContext,
  GraphToolResult,
  SymbolRef,
} from './symbol-dto.js';
import type { TargetConventionSummary } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';
import type { Catalog, FeatureColumn } from '@opensip-cli/graph';

const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_ARCH_LIMIT = 25;
const DEFAULT_WALK_LIMIT = 100;
const CURSOR_VERSION = 1 as const;
const LOG_QUERY_FAILED = 'mcp.graph.query.failed';
const LOG_QUERY_COMPLETED = 'mcp.graph.query.completed';
const OUTCOME_FAILED = 'failed';
const OUTCOME_OK = 'ok';

function resultDataCount(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data === undefined || data === null) return 0;
  return 1;
}

function resolveWalkNode(
  gen: CatalogGeneration,
  viewNodes: readonly (SymbolRef | undefined)[],
  key: string,
  identity: 'occurrence' | 'body-twin-union',
): SymbolRef | undefined {
  if (identity === 'occurrence') {
    const occ = gen.indexes.byOccId.get(key);
    if (occ !== undefined) return toSymbolRef(occ);
    return viewNodes.find((n) => n?.symbolId === key);
  }
  const occ = gen.indexes.byBodyHash.get(key);
  if (occ !== undefined) return toSymbolRef(occ);
  return viewNodes.find((n) => n?.bodyHash === key);
}

export interface SqliteGraphReadPortDeps {
  readonly store: DataStore;
  readonly projectRoot: string;
  readonly configPath?: string;
  readonly adapters: GraphAdapterRegistryReader;
  readonly rebuild: () => Promise<Result<Catalog, McpReadError>>;
  readonly config?: GraphConfig;
  readonly targetConventions?: readonly TargetConventionSummary[];
  readonly log?: (
    evt: string,
    fields: Record<string, string | number | boolean | undefined>,
  ) => void;
}

export class SqliteGraphReadPort implements GraphReadPort {
  private readonly controller: GraphGenerationController;
  private readonly config: GraphConfig;
  private readonly projectRoot: string;
  private readonly configPath: string;
  private readonly projectKey: string;
  private readonly targetConventions: readonly TargetConventionSummary[] | undefined;
  private readonly log:
    | ((evt: string, fields: Record<string, string | number | boolean | undefined>) => void)
    | undefined;
  private blastCache:
    | {
        readonly key: string;
        readonly scores: ReadonlyMap<string, { direct: number; transitive: number; score: number }>;
      }
    | undefined;

  constructor(private readonly deps: SqliteGraphReadPortDeps) {
    this.config = deps.config ?? {};
    this.projectRoot = deps.projectRoot;
    this.configPath = deps.configPath ?? 'opensip-cli.config.yml';
    this.projectKey = ephemeralProjectCacheKey(deps.projectRoot);
    this.targetConventions = deps.targetConventions;
    this.log = deps.log;
    this.controller = new GraphGenerationController({
      store: deps.store,
      projectRoot: deps.projectRoot,
      adapters: deps.adapters,
      readIdentity: (store) => readCatalogIdentity(store),
      loadCatalog: (store) => loadCatalogGeneration(store),
      verify: (input) => verifyCatalogInputs(input),
      rebuild: deps.rebuild,
      log: deps.log,
    });
  }

  /** Expose project key for cursor binding tests. */
  getProjectKey(): string {
    return this.projectKey;
  }

  private async runQuery<T>(
    operation: string,
    project: (gen: CatalogGeneration | undefined, freshness: Freshness) => GraphToolResult<T>,
  ): Promise<Result<GraphToolResult<T>, McpReadError>> {
    const started = Date.now();
    try {
      const captured = await this.controller.capture();
      if (!captured.ok) {
        this.log?.(LOG_QUERY_FAILED, {
          operation,
          outcome: OUTCOME_FAILED,
          durationMs: Date.now() - started,
        });
        return captured;
      }
      const gen = captured.value;
      const freshness = await this.freshnessFor(gen);
      const result = project(gen, freshness);
      this.log?.(LOG_QUERY_COMPLETED, {
        operation,
        identityMode: 'body-twin-union',
        resultCount: resultDataCount(result.data),
        coverageComplete: result.coverage.complete,
        coverageTruncated: result.coverage.truncated,
        outcome: OUTCOME_OK,
        durationMs: Date.now() - started,
      });
      return ok(result);
    } catch {
      this.log?.(LOG_QUERY_FAILED, {
        operation,
        outcome: OUTCOME_FAILED,
        durationMs: Date.now() - started,
      });
      return err(
        readError('graph-query-failed', 'Graph query failed due to an infrastructure error.'),
      );
    }
  }

  private async freshnessFor(gen: CatalogGeneration | undefined): Promise<Freshness> {
    if (gen === undefined) return missingFreshness();
    const verified = await this.controller.verifyCurrent(gen);
    if (!verified.ok) {
      return {
        fresh: false,
        builtAt: gen.builtAt,
        verifiedAt: new Date().toISOString(),
        verification: 'partial',
        reasonCode: 'verification-unavailable',
        reason: 'Freshness verification failed',
      };
    }
    return freshnessFromVerification(verified.value, gen.builtAt);
  }

  private contextFor(gen: CatalogGeneration | undefined): GraphEvidenceContext {
    if (gen === undefined) {
      return {
        project: {
          root: this.projectRoot,
          scope: 'project',
          configPath: this.configPath,
        },
        catalog: { status: 'missing' },
      };
    }
    return {
      project: {
        root: this.projectRoot,
        scope: 'project',
        configPath: this.configPath,
      },
      catalog: {
        status: 'loaded',
        builtAt: gen.builtAt,
        language: gen.catalog.language,
        resolutionMode: gen.catalog.resolutionMode ?? 'exact',
        engineMode: gen.catalog.engineMode,
        identity: gen.key,
        loadedAt: gen.loadedAt,
        generationSource: gen.source,
      },
    };
  }

  private envelope<T>(
    data: T,
    gen: CatalogGeneration | undefined,
    freshness: Freshness,
    coverage?: GraphCoverage,
    page?: { limit: number; nextCursor?: string },
    extras?: {
      filter?: GraphSourceFilter;
      groups?: readonly GroupSummary[];
    },
  ): GraphToolResult<T> {
    const cov = coverage ?? { complete: true, truncated: false, reasons: [] };
    return {
      data,
      context: this.contextFor(gen),
      freshness,
      ...(page === undefined ? {} : { page }),
      coverage: cov,
      ...(extras?.filter === undefined ? {} : { filter: extras.filter }),
      ...(extras?.groups === undefined ? {} : { groups: extras.groups }),
    };
  }

  private resolveFilter(
    partial: Partial<GraphSourceFilter> | undefined,
    defaults: 'discover' | 'production',
  ): GraphSourceFilter {
    if (defaults === 'production') return this.defaultProductionFilter(partial);
    return {
      sourceScope: partial?.sourceScope ?? 'all',
      generated: partial?.generated ?? 'include',
      ...(partial?.packages === undefined ? {} : { packages: partial.packages }),
      ...(partial?.filePath === undefined ? {} : { filePath: partial.filePath }),
      ...(partial?.filePrefix === undefined ? {} : { filePrefix: partial.filePrefix }),
      ...(partial?.kinds === undefined ? {} : { kinds: partial.kinds }),
      ...(partial?.visibilities === undefined ? {} : { visibilities: partial.visibilities }),
    };
  }

  /**
   * Decode/bind a cursor for the current project/generation/query.
   * Returns afterKey or a typed cursor error.
   */
  private resolveAfterKey(
    cursor: string | undefined,
    binding: {
      projectKey: string;
      generationKey: string;
      queryDigest: string;
    },
  ): Result<string | undefined, McpReadError> {
    if (cursor === undefined) return ok(undefined);
    const decoded = decodeCursor(cursor);
    if (!decoded.ok) return decoded;
    const bound = bindCursor(decoded.value, binding);
    if (!bound.ok) return bound;
    return ok(bound.value.afterKey);
  }

  private nextCursorFor(
    binding: {
      projectKey: string;
      generationKey: string;
      queryDigest: string;
    },
    afterKey: string,
  ): string {
    return encodeCursor({
      v: CURSOR_VERSION,
      projectKey: binding.projectKey,
      generationKey: binding.generationKey,
      queryDigest: binding.queryDigest,
      afterKey,
    });
  }

  private emptyArchitecture(filter: GraphSourceFilter): ArchitectureSummaryDto {
    return {
      languages: [],
      occurrenceCount: {
        value: 0,
        nodeIdentity: 'occurrence',
        sourceScope: filter.sourceScope,
        generated: filter.generated,
      },
      uniqueBodyCount: {
        value: 0,
        nodeIdentity: 'body-hash',
        sourceScope: filter.sourceScope,
        generated: filter.generated,
      },
      callEvidence: {
        resolvedCallSites: 0,
        resolvedTargets: 0,
        unresolvedCallSites: 0,
        confidence: {},
        resolution: {},
        edgeKind: 'call',
        catalogResolutionMode: undefined,
      },
      packageCount: 0,
      packageEdges: [],
      hotspots: [],
      ...(this.targetConventions === undefined
        ? {}
        : { targetConventions: this.targetConventions }),
    };
  }

  async catalogStatus(): Promise<Result<CatalogStatus, McpReadError>> {
    const captured = await this.controller.capture();
    if (!captured.ok) return captured;
    const gen = captured.value;
    const freshness = await this.freshnessFor(gen);
    return ok({ context: this.contextFor(gen), freshness });
  }

  async resolveSymbolId(
    symbolId: string,
  ): Promise<Result<GraphToolResult<SymbolRef | undefined>, McpReadError>> {
    return this.runQuery('resolveSymbolId', (gen, freshness) => {
      if (gen === undefined) {
        return this.envelope(undefined, gen, freshness);
      }
      const occ = gen.indexes.byOccId.get(symbolId);
      return this.envelope(occ === undefined ? undefined : toSymbolRef(occ), gen, freshness);
    });
  }

  async searchSymbols(
    query: string,
    opts?: SearchSymbolsOptions,
  ): Promise<Result<GraphToolResult<readonly SymbolRef[]>, McpReadError>> {
    const started = Date.now();
    const operation = 'searchSymbols';
    try {
      const captured = await this.controller.capture();
      if (!captured.ok) {
        this.log?.(LOG_QUERY_FAILED, {
          operation,
          outcome: OUTCOME_FAILED,
          durationMs: Date.now() - started,
        });
        return captured;
      }
      const gen = captured.value;
      const freshness = await this.freshnessFor(gen);
      const limit = clampLimit(opts?.limit, DEFAULT_SEARCH_LIMIT);
      const match = opts?.match ?? 'substring';
      const filter = this.resolveFilter(opts?.filter, 'discover');
      const groupBy = opts?.groupBy ?? 'none';
      const normalizedQuery = {
        op: 'searchSymbols',
        query,
        match,
        filter,
        groupBy,
      };
      const queryDigest = digestNormalizedQuery(normalizedQuery);

      if (gen === undefined) {
        const result = this.envelope(
          [] as readonly SymbolRef[],
          gen,
          freshness,
          { complete: true, truncated: false, reasons: [] },
          { limit },
          { filter },
        );
        this.log?.(LOG_QUERY_COMPLETED, {
          operation,
          resultCount: 0,
          coverageComplete: true,
          coverageTruncated: false,
          outcome: OUTCOME_OK,
          durationMs: Date.now() - started,
        });
        return ok(result);
      }

      const binding = {
        projectKey: this.projectKey,
        generationKey: gen.key,
        queryDigest,
      };
      const after = this.resolveAfterKey(opts?.cursor, binding);
      if (!after.ok) {
        this.log?.(LOG_QUERY_FAILED, {
          operation,
          outcome: OUTCOME_FAILED,
          durationMs: Date.now() - started,
        });
        return after;
      }

      const searched = searchSymbolOccurrences(gen.catalog, gen.indexes, {
        query,
        match,
        filter,
        limit,
        ...(after.value === undefined ? {} : { afterKey: after.value }),
      });
      if (!searched.ok) {
        return err(fromGraphReadError(searched.error));
      }

      const symbols = searched.value.symbols;
      const grouped = groupRows(symbols, groupBy, (row, mode) =>
        mode === 'package' ? row.package : row.filePath,
      );
      const lastSymbol = symbols.at(-1);
      const nextCursor =
        searched.value.hasMore && lastSymbol !== undefined
          ? this.nextCursorFor(binding, symbolSearchStableKey(lastSymbol))
          : undefined;

      const coverageReasons = [
        ...searched.value.coverage.reasons,
        ...(grouped.groupTruncated ? ['group-key-cap'] : []),
      ];
      const result = this.envelope(
        symbols,
        gen,
        freshness,
        {
          complete: coverageReasons.length === 0,
          truncated: coverageReasons.includes('malformed-symbol-omitted'),
          reasons: coverageReasons,
        },
        { limit, ...(nextCursor === undefined ? {} : { nextCursor }) },
        {
          filter: searched.value.effectiveFilter,
          ...(grouped.groups === undefined ? {} : { groups: grouped.groups }),
        },
      );
      this.log?.(LOG_QUERY_COMPLETED, {
        operation,
        resultCount: symbols.length,
        coverageComplete: result.coverage.complete,
        coverageTruncated: result.coverage.truncated,
        outcome: OUTCOME_OK,
        durationMs: Date.now() - started,
      });
      return ok(result);
    } catch {
      this.log?.(LOG_QUERY_FAILED, {
        operation,
        outcome: OUTCOME_FAILED,
        durationMs: Date.now() - started,
      });
      return err(
        readError('graph-query-failed', 'Graph query failed due to an infrastructure error.'),
      );
    }
  }

  async findBySpan(
    file: string,
    line: number,
  ): Promise<Result<GraphToolResult<readonly SymbolRef[]>, McpReadError>> {
    return this.runQuery('findBySpan', (gen, freshness) => {
      if (gen === undefined) {
        return this.envelope([] as readonly SymbolRef[], gen, freshness);
      }
      const out: SymbolRef[] = [];
      for (const occ of gen.indexes.byOccId.values()) {
        if (occ.filePath === file && occ.line <= line && line <= occ.endLine) {
          const ref = toSymbolRef(occ);
          if (ref !== undefined) out.push(ref);
        }
      }
      return this.envelope(out, gen, freshness);
    });
  }

  async traverse(
    query: TraversalQuery,
  ): Promise<Result<GraphToolResult<TraversalSnapshot>, McpReadError>> {
    // eslint-disable-next-line sonarjs/cognitive-complexity -- path vs walk projection branches
    return this.runQuery('traverse', (gen, freshness) => {
      const limit = clampLimit(query.limit, DEFAULT_WALK_LIMIT);
      const depth = query.depth ?? 5;
      const identity = query.identity ?? 'occurrence';
      if (gen === undefined) {
        return this.envelope(
          {
            found: false,
            nodes: [],
            truncated: false,
            identityMode: identity,
          },
          gen,
          freshness,
          { complete: true, truncated: false, reasons: [] },
          { limit },
        );
      }
      const startOcc = gen.indexes.byOccId.get(query.startSymbolId);
      if (startOcc === undefined) {
        return this.envelope(
          {
            found: false,
            nodes: [],
            truncated: false,
            identityMode: identity,
          },
          gen,
          freshness,
          { complete: true, truncated: false, reasons: [] },
          { limit },
        );
      }

      const filter: GraphSourceFilter = {
        sourceScope: query.filter?.sourceScope ?? 'all',
        generated: query.filter?.generated ?? 'include',
        ...(query.filter?.packages === undefined ? {} : { packages: query.filter.packages }),
        ...(query.filter?.filePath === undefined ? {} : { filePath: query.filter.filePath }),
        ...(query.filter?.filePrefix === undefined ? {} : { filePrefix: query.filter.filePrefix }),
        ...(query.filter?.kinds === undefined ? {} : { kinds: query.filter.kinds }),
        ...(query.filter?.visibilities === undefined
          ? {}
          : { visibilities: query.filter.visibilities }),
      };
      const view = buildOccurrenceCallView(gen.catalog, gen.indexes, {
        filter,
        identity,
        startSymbolId: query.startSymbolId,
      });
      if (!view.ok) {
        return this.envelope(
          { found: false, nodes: [], truncated: false, identityMode: identity },
          gen,
          freshness,
          { complete: false, truncated: false, reasons: ['occurrence-view-failed'] },
          { limit },
        );
      }

      const startKey = identity === 'body-twin-union' ? startOcc.bodyHash : query.startSymbolId;
      let adj = view.value.forward;
      if (query.direction === 'callers') {
        adj = view.value.reverse;
      }

      if (query.direction === 'path') {
        if (query.goalSymbolId === undefined) {
          return this.envelope(
            {
              found: false,
              nodes: [],
              path: [],
              truncated: false,
              identityMode: identity,
            },
            gen,
            freshness,
          );
        }
        const goalOcc = gen.indexes.byOccId.get(query.goalSymbolId);
        if (goalOcc === undefined) {
          return this.envelope(
            {
              found: false,
              nodes: [],
              path: [],
              truncated: false,
              identityMode: identity,
            },
            gen,
            freshness,
          );
        }
        const goalKey = identity === 'body-twin-union' ? goalOcc.bodyHash : query.goalSymbolId;
        const walk = boundedBfs(adj, startKey, {
          depth,
          cap: 2000,
          goal: goalKey,
        });
        const pathKeys = walk.foundGoal ? reconstructPath(walk.parents, startKey, goalKey) : [];
        const path = pathKeys
          .map((key) => resolveWalkNode(gen, view.value.nodes, key, identity))
          .filter((s): s is SymbolRef => s !== undefined);
        return this.envelope(
          {
            found: walk.foundGoal,
            nodes: path.map((symbol, i) => ({ symbol, depth: i })),
            path,
            truncated: walk.truncated,
            identityMode: identity,
          },
          gen,
          freshness,
          {
            complete: !walk.truncated,
            truncated: walk.truncated,
            reasons: walk.truncated ? ['walk-node-cap'] : [],
          },
          { limit },
        );
      }

      const walk = boundedBfs(adj, startKey, { depth, cap: 2000 });
      const nodes: { symbol: SymbolRef; depth: number }[] = [];
      const self = toSymbolRef(startOcc);
      if (self !== undefined) nodes.push({ symbol: self, depth: 0 });
      let pageTruncated = false;
      let depthCounter = 1;
      for (const key of walk.order) {
        if (nodes.length >= limit) {
          pageTruncated = true;
          break;
        }
        const ref = resolveWalkNode(gen, view.value.nodes, key, identity);
        if (ref !== undefined) {
          nodes.push({ symbol: ref, depth: depthCounter });
          depthCounter++;
        }
      }
      const hardCap = walk.truncated;
      return this.envelope(
        {
          found: nodes.length > 0,
          nodes,
          truncated: hardCap,
          identityMode: identity,
        },
        gen,
        freshness,
        {
          complete: !hardCap,
          truncated: hardCap,
          reasons: [
            ...(hardCap ? ['walk-node-cap'] : []),
            ...(pageTruncated ? ['page-limit'] : []),
          ],
        },
        { limit },
      );
    });
  }

  async blast(
    symbolId: string,
  ): Promise<Result<GraphToolResult<BlastDto | undefined>, McpReadError>> {
    return this.runQuery('blast', (gen, freshness) => {
      if (gen === undefined) return this.envelope(undefined, gen, freshness);
      const occ = gen.indexes.byOccId.get(symbolId);
      if (occ === undefined) return this.envelope(undefined, gen, freshness);
      const score = this.blastScores(gen).get(occ.bodyHash);
      if (score === undefined) return this.envelope(undefined, gen, freshness);
      const symbol = toSymbolRef(occ);
      if (symbol === undefined) return this.envelope(undefined, gen, freshness);
      const twinCount = [...gen.indexes.byOccId.values()].filter(
        (o) => o.bodyHash === occ.bodyHash,
      ).length;
      return this.envelope(
        {
          symbol,
          ...score,
          identityMode: 'body-twin-union',
          twinCount,
        },
        gen,
        freshness,
      );
    });
  }

  private blastScores(
    gen: CatalogGeneration,
  ): ReadonlyMap<string, { direct: number; transitive: number; score: number }> {
    if (this.blastCache?.key === gen.key) {
      return this.blastCache.scores;
    }
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
    this.blastCache = { key: gen.key, scores: out };
    return out;
  }

  async deadCode(
    query?: DeadCodeQuery,
  ): Promise<Result<GraphToolResult<readonly DeadCodeDto[]>, McpReadError>> {
    const started = Date.now();
    const operation = 'deadCode';
    try {
      const captured = await this.controller.capture();
      if (!captured.ok) {
        this.log?.(LOG_QUERY_FAILED, {
          operation,
          outcome: OUTCOME_FAILED,
          durationMs: Date.now() - started,
        });
        return captured;
      }
      const gen = captured.value;
      const freshness = await this.freshnessFor(gen);
      const limit = clampLimit(query?.limit, DEFAULT_SEARCH_LIMIT);
      const filter = this.resolveFilter(query?.filter, 'discover');
      const groupBy = query?.groupBy ?? 'none';
      const queryDigest = digestNormalizedQuery({ op: 'deadCode', filter, groupBy });

      if (gen === undefined) {
        return ok(
          this.envelope(
            [] as readonly DeadCodeDto[],
            gen,
            freshness,
            { complete: true, truncated: false, reasons: [] },
            { limit },
            { filter },
          ),
        );
      }

      const binding = {
        projectKey: this.projectKey,
        generationKey: gen.key,
        queryDigest,
      };
      const after = this.resolveAfterKey(query?.cursor, binding);
      if (!after.ok) return after;

      const page = pageDeadCode(gen, this.config, filter, limit, after.value);
      const grouped = groupRows(page.rows, groupBy, (row, mode) =>
        mode === 'package' ? row.symbol.package : row.symbol.filePath,
      );
      const last = page.rows.at(-1);
      const nextCursor =
        page.hasMore && last !== undefined
          ? this.nextCursorFor(binding, symbolSearchStableKey(last.symbol))
          : undefined;

      const result = this.envelope(
        page.rows,
        gen,
        freshness,
        {
          complete: true,
          truncated: false,
          reasons: grouped.groupTruncated ? ['group-key-cap'] : [],
        },
        { limit, ...(nextCursor === undefined ? {} : { nextCursor }) },
        {
          filter,
          ...(grouped.groups === undefined ? {} : { groups: grouped.groups }),
        },
      );
      this.log?.(LOG_QUERY_COMPLETED, {
        operation,
        resultCount: page.rows.length,
        coverageComplete: true,
        coverageTruncated: false,
        outcome: OUTCOME_OK,
        durationMs: Date.now() - started,
      });
      return ok(result);
    } catch {
      this.log?.(LOG_QUERY_FAILED, {
        operation,
        outcome: OUTCOME_FAILED,
        durationMs: Date.now() - started,
      });
      return err(
        readError('graph-query-failed', 'Graph query failed due to an infrastructure error.'),
      );
    }
  }

  async architectureSummary(
    query?: ArchitectureQuery,
  ): Promise<Result<GraphToolResult<ArchitectureSummaryDto>, McpReadError>> {
    const started = Date.now();
    const operation = 'architectureSummary';
    try {
      const captured = await this.controller.capture();
      if (!captured.ok) {
        this.log?.(LOG_QUERY_FAILED, {
          operation,
          outcome: OUTCOME_FAILED,
          durationMs: Date.now() - started,
        });
        return captured;
      }
      const gen = captured.value;
      const freshness = await this.freshnessFor(gen);
      const limit = clampLimit(query?.limit, DEFAULT_ARCH_LIMIT);
      const filter = this.resolveFilter(query?.filter, 'production');
      const groupBy = query?.groupBy ?? 'none';
      const normalizedQuery = { op: 'architectureSummary', filter, groupBy };
      const queryDigest = digestNormalizedQuery(normalizedQuery);

      if (gen === undefined) {
        return ok(
          this.envelope(
            this.emptyArchitecture(filter),
            gen,
            freshness,
            { complete: true, truncated: false, reasons: [] },
            { limit },
            { filter },
          ),
        );
      }

      const binding = {
        projectKey: this.projectKey,
        generationKey: gen.key,
        queryDigest,
      };
      const after = this.resolveAfterKey(query?.cursor, binding);
      if (!after.ok) return after;

      // Cursor afterKey applies to package edges; hotspots use the same page size.
      const view = buildArchitectureView(gen.catalog, gen.indexes, {
        filter,
        limit,
        ...(after.value === undefined ? {} : { afterPackageEdgeKey: after.value }),
      });
      if (!view.ok) {
        return err(fromGraphReadError(view.error));
      }

      const packageEdges = view.value.packageEdges;
      const hotspots: BlastDto[] = view.value.hotspots.map((h) => ({
        symbol: h.symbol,
        direct: h.direct,
        transitive: h.transitive,
        score: h.score,
        identityMode: h.identityMode,
        twinCount: h.twinCount,
      }));

      const grouped = groupRows(packageEdges, groupBy, (row, mode) =>
        mode === 'package' ? row.fromPackage : `${row.fromPackage}->${row.toPackage}`,
      );

      const hasMore = view.value.packageEdgesHasMore || view.value.hotspotsHasMore;
      const nextCursor = architectureNextCursor(hasMore, packageEdges, hotspots, (afterKey) =>
        this.nextCursorFor(binding, afterKey),
      );

      const data: ArchitectureSummaryDto = {
        languages: view.value.languages,
        occurrenceCount: view.value.occurrenceCount,
        uniqueBodyCount: view.value.uniqueBodyCount,
        callEvidence: view.value.callEvidence,
        packageCount: view.value.packageCount,
        packageEdges,
        hotspots,
        ...(this.targetConventions === undefined
          ? {}
          : { targetConventions: this.targetConventions }),
      };

      const result = this.envelope(
        data,
        gen,
        freshness,
        view.value.coverage,
        { limit, ...(nextCursor === undefined ? {} : { nextCursor }) },
        {
          filter: view.value.effectiveFilter,
          ...(grouped.groups === undefined ? {} : { groups: grouped.groups }),
        },
      );
      this.log?.(LOG_QUERY_COMPLETED, {
        operation,
        resultCount: packageEdges.length + hotspots.length,
        coverageComplete: result.coverage.complete,
        coverageTruncated: result.coverage.truncated,
        outcome: OUTCOME_OK,
        durationMs: Date.now() - started,
      });
      return ok(result);
    } catch {
      this.log?.(LOG_QUERY_FAILED, {
        operation,
        outcome: OUTCOME_FAILED,
        durationMs: Date.now() - started,
      });
      return err(
        readError('graph-query-failed', 'Graph query failed due to an infrastructure error.'),
      );
    }
  }

  private defaultProductionFilter(partial?: Partial<GraphSourceFilter>): GraphSourceFilter {
    return {
      sourceScope: partial?.sourceScope ?? 'production',
      generated: partial?.generated ?? 'exclude',
      ...(partial?.packages === undefined ? {} : { packages: partial.packages }),
      ...(partial?.filePath === undefined ? {} : { filePath: partial.filePath }),
      ...(partial?.filePrefix === undefined ? {} : { filePrefix: partial.filePrefix }),
      ...(partial?.kinds === undefined ? {} : { kinds: partial.kinds }),
      ...(partial?.visibilities === undefined ? {} : { visibilities: partial.visibilities }),
    };
  }

  async packageDependencies(
    query: PackageDependenciesQuery,
  ): Promise<Result<GraphToolResult<PackageDependenciesDto>, McpReadError>> {
    const edgeKind = query.edgeKind ?? 'call';
    return this.runQuery('packageDependencies', (gen, freshness) => {
      if (gen === undefined) {
        return this.envelope({ edgeKind, calls: [], imports: [] }, gen, freshness);
      }
      const filter = this.defaultProductionFilter(query.filter);
      let packages: { fromPackage?: string; toPackage?: string } | undefined;
      if (query.package !== undefined) {
        if (query.direction === 'in') packages = { toPackage: query.package };
        else if (query.direction === 'both') packages = {};
        else packages = { fromPackage: query.package };
      }
      const view = buildPackageEvidence(gen.catalog, gen.indexes, {
        edgeKind,
        filter,
        ...packages,
      });
      if (!view.ok) {
        return this.envelope({ edgeKind, calls: [], imports: [] }, gen, freshness, {
          complete: false,
          truncated: false,
          reasons: ['package-evidence-failed'],
        });
      }
      let calls = view.value.calls;
      let imports = view.value.imports;
      if (query.package !== undefined && query.direction === 'both') {
        calls = calls.filter(
          (c) => c.fromPackage === query.package || c.toPackage === query.package,
        );
        imports = imports.filter(
          (c) => c.fromPackage === query.package || c.toPackage === query.package,
        );
      } else if (query.package !== undefined && query.direction === 'in') {
        calls = calls.filter((c) => c.toPackage === query.package);
        imports = imports.filter((c) => c.toPackage === query.package);
      }
      const limit = clampLimit(query.limit, DEFAULT_ARCH_LIMIT);
      return this.envelope(
        {
          edgeKind,
          calls: calls.slice(0, limit),
          imports: imports.slice(0, limit),
        },
        gen,
        freshness,
        {
          complete:
            view.value.coverage.complete && calls.length <= limit && imports.length <= limit,
          truncated: calls.length > limit || imports.length > limit,
          reasons: [
            ...view.value.coverage.reasons,
            ...(calls.length > limit || imports.length > limit ? ['page-limit'] : []),
          ],
        },
        { limit },
      );
    });
  }

  async whyDepends(
    query: WhyDependsQuery,
  ): Promise<Result<GraphToolResult<PackageDependenciesDto>, McpReadError>> {
    const edgeKind = query.edgeKind ?? 'combined';
    return this.runQuery('whyDepends', (gen, freshness) => {
      if (gen === undefined) {
        return this.envelope({ edgeKind, calls: [], imports: [] }, gen, freshness);
      }
      const view = buildPackageEvidence(gen.catalog, gen.indexes, {
        edgeKind,
        filter: this.defaultProductionFilter(query.filter),
        fromPackage: query.fromPackage,
        toPackage: query.toPackage,
      });
      if (!view.ok) {
        return this.envelope({ edgeKind, calls: [], imports: [] }, gen, freshness, {
          complete: false,
          truncated: false,
          reasons: ['package-evidence-failed'],
        });
      }
      const limit = clampLimit(query.limit, DEFAULT_ARCH_LIMIT);
      return this.envelope(
        {
          edgeKind,
          calls: view.value.calls.slice(0, limit),
          imports: view.value.imports.slice(0, limit),
        },
        gen,
        freshness,
        view.value.coverage,
        { limit },
      );
    });
  }

  async packageCycles(
    query: PackageCyclesQuery,
  ): Promise<Result<GraphToolResult<PackageCyclesDto>, McpReadError>> {
    const edgeKind = query.edgeKind ?? 'call';
    return this.runQuery('packageCycles', (gen, freshness) => {
      if (gen === undefined) {
        return this.envelope({ edgeKind, components: [] }, gen, freshness);
      }
      const view = buildPackageScc(gen.catalog, gen.indexes, {
        edgeKind,
        filter: this.defaultProductionFilter(query.filter),
      });
      if (!view.ok) {
        return this.envelope({ edgeKind, components: [] }, gen, freshness, {
          complete: false,
          truncated: false,
          reasons: ['package-scc-failed'],
        });
      }
      const limit = clampLimit(query.limit, DEFAULT_ARCH_LIMIT);
      return this.envelope(
        {
          edgeKind,
          components: view.value.components.slice(0, limit).map((c) => ({
            packages: c.packages,
            proofEdges: c.proofEdges,
            totalProofEdges: c.totalProofEdges,
          })),
        },
        gen,
        freshness,
        view.value.coverage,
        { limit },
      );
    });
  }

  async refresh(opts?: {
    forceRebuild?: boolean;
  }): Promise<Result<GraphToolResult<RefreshResult>, McpReadError>> {
    const started = Date.now();
    const outcome = await this.controller.refresh(opts?.forceRebuild === true);
    if (!outcome.ok) {
      this.log?.('mcp.graph.refresh.failed', {
        action: 'failed',
        outcome: OUTCOME_FAILED,
        durationMs: Date.now() - started,
        priorGenerationAvailable: outcome.error.details?.priorGenerationAvailable === true,
      });
      return outcome;
    }
    this.blastCache = undefined;
    const gen = outcome.value.generation;
    const freshness = await this.freshnessFor(gen);
    const data: RefreshResult = {
      generation: {
        builtAt: gen.builtAt,
        identity: gen.key,
        source: gen.source,
      },
      action: outcome.value.action,
      durationMs: outcome.value.durationMs,
      priorGenerationAvailable: outcome.value.priorGenerationAvailable,
    };
    this.log?.('mcp.graph.refresh.completed', {
      action: outcome.value.action,
      outcome: OUTCOME_OK,
      durationMs: outcome.value.durationMs,
      priorGenerationAvailable: outcome.value.priorGenerationAvailable,
    });
    return ok(this.envelope(data, gen, freshness));
  }
}

export { type GraphGeneration } from './graph-read-port.js';

/** Filter-first orphan projection, sorted, then limited after `afterKey`. */
function pageDeadCode(
  gen: CatalogGeneration,
  config: GraphConfig,
  filter: GraphSourceFilter,
  limit: number,
  afterKey: string | undefined,
): { rows: DeadCodeDto[]; hasMore: boolean } {
  const columns: readonly FeatureColumn[] = ['reachableFromEntry'];
  const features = deriveGraphReadFeatures(gen.catalog, gen.indexes, config, columns);
  const signals = evaluateGraphOrphans(gen.catalog, gen.indexes, config, features);
  const filtered: DeadCodeDto[] = [];
  for (const signal of signals) {
    const dto = toDeadCodeDto(signal, gen.indexes);
    if (dto === undefined) continue;
    if (!matchesGraphSourceFilter(dto.symbol, filter)) continue;
    filtered.push(dto);
  }
  filtered.sort((a, b) => {
    const ka = symbolSearchStableKey(a.symbol);
    const kb = symbolSearchStableKey(b.symbol);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
  const rows: DeadCodeDto[] = [];
  let hasMore = false;
  for (const row of filtered) {
    const key = symbolSearchStableKey(row.symbol);
    if (afterKey !== undefined && key <= afterKey) continue;
    if (rows.length < limit) {
      rows.push(row);
      continue;
    }
    hasMore = true;
    break;
  }
  return { rows, hasMore };
}

function architectureNextCursor(
  hasMore: boolean,
  packageEdges: readonly { fromPackage: string; toPackage: string }[],
  hotspots: readonly BlastDto[],
  encode: (afterKey: string) => string,
): string | undefined {
  if (!hasMore) return undefined;
  const lastEdge = packageEdges.at(-1);
  if (lastEdge !== undefined) {
    return encode(
      packageEdgeStableKey({
        fromPackage: lastEdge.fromPackage,
        toPackage: lastEdge.toPackage,
        kind: 'call',
        count: 0,
        countUnit: 'call-sites',
      }),
    );
  }
  const lastHotspot = hotspots.at(-1);
  if (lastHotspot === undefined) return undefined;
  return encode(
    hotspotStableKey({
      symbol: lastHotspot.symbol,
      direct: lastHotspot.direct,
      transitive: lastHotspot.transitive,
      score: lastHotspot.score,
      identityMode: 'body-twin-union',
      twinCount: lastHotspot.twinCount ?? 1,
    }),
  );
}
