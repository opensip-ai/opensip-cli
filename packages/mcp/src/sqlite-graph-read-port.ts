/**
 * SQLite-backed {@link GraphReadPort} (ADR-0084 + MCP Graph Audit Phase 1).
 *
 * Composes {@link GraphGenerationController} for lifecycle and owns query
 * projection + evidence-envelope assembly. Passes the injected datastore only
 * to public graph/read functions — never accesses `.db` or graph persistence.
 */

import { ephemeralProjectCacheKey, err, ok, type Result } from '@opensip-cli/core';
import {
  buildOccurrenceCallView,
  buildPackageEvidence,
  buildPackageScc,
  deriveGraphReadFeatures,
  evaluateGraphOrphans,
  loadCatalogGeneration,
  readCatalogIdentity,
  toGraphSymbolRef,
  verifyCatalogInputs,
  type GraphAdapterRegistryReader,
  type GraphConfig,
  type GraphSourceFilter,
} from '@opensip-cli/graph/read';

import { GraphGenerationController, type CatalogGeneration } from './catalog-generation.js';
import { freshnessFromVerification, missingFreshness } from './freshness.js';
import { clampLimit, edgeCount, toDeadCodeDto, toSymbolRef } from './graph-read-projection.js';
import { fromGraphReadError, readError } from './mcp-error.js';
import { boundedBfs, reconstructPath } from './tools/graph-walk.js';

import type {
  ArchitecturePackageDto,
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

const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_ARCH_LIMIT = 25;
const DEFAULT_WALK_LIMIT = 100;

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
        this.log?.('mcp.graph.query.failed', {
          operation,
          outcome: 'failed',
          durationMs: Date.now() - started,
        });
        return captured;
      }
      const gen = captured.value;
      const freshness = await this.freshnessFor(gen);
      const result = project(gen, freshness);
      this.log?.('mcp.graph.query.completed', {
        operation,
        identityMode: 'body-twin-union',
        resultCount: resultDataCount(result.data),
        coverageComplete: result.coverage.complete,
        coverageTruncated: result.coverage.truncated,
        outcome: 'ok',
        durationMs: Date.now() - started,
      });
      return ok(result);
    } catch {
      this.log?.('mcp.graph.query.failed', {
        operation,
        outcome: 'failed',
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
  ): GraphToolResult<T> {
    const cov = coverage ?? { complete: true, truncated: false, reasons: [] };
    return {
      data,
      context: this.contextFor(gen),
      freshness,
      ...(page === undefined ? {} : { page }),
      coverage: cov,
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
    return this.runQuery('searchSymbols', (gen, freshness) => {
      if (gen === undefined) {
        return this.envelope(
          [] as readonly SymbolRef[],
          gen,
          freshness,
          {
            complete: true,
            truncated: false,
            reasons: [],
          },
          { limit: clampLimit(opts?.limit, DEFAULT_SEARCH_LIMIT) },
        );
      }
      const limit = clampLimit(opts?.limit, DEFAULT_SEARCH_LIMIT);
      const needle = query.toLowerCase();
      const matches: SymbolRef[] = [];
      let truncated = false;
      for (const occ of gen.indexes.byOccId.values()) {
        if (occ.kind === 'module-init') continue;
        if (opts?.kind !== undefined && occ.kind !== opts.kind) continue;
        if (!occ.simpleName.toLowerCase().includes(needle)) continue;
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        const ref = toSymbolRef(occ);
        if (ref !== undefined) matches.push(ref);
      }
      return this.envelope(
        matches,
        gen,
        freshness,
        {
          complete: !truncated,
          truncated,
          reasons: truncated ? ['search-limit'] : [],
        },
        { limit },
      );
    });
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

      const startKey =
        identity === 'body-twin-union' ? startOcc.bodyHash : query.startSymbolId;
      const adj =
        query.direction === 'callers' || query.direction === 'path'
          ? query.direction === 'callers'
            ? view.value.reverse
            : view.value.forward
          : view.value.forward;

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
        const goalKey =
          identity === 'body-twin-union' ? goalOcc.bodyHash : query.goalSymbolId;
        const walk = boundedBfs(adj, startKey, {
          depth,
          cap: 2000,
          goal: goalKey,
        });
        const pathKeys = walk.foundGoal
          ? reconstructPath(walk.parents, startKey, goalKey)
          : [];
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
    query?: DeadCodeQuery | number,
  ): Promise<Result<GraphToolResult<readonly DeadCodeDto[]>, McpReadError>> {
    const limit = typeof query === 'number' ? query : query?.limit;
    return this.runQuery('deadCode', (gen, freshness) => {
      if (gen === undefined) {
        return this.envelope([] as readonly DeadCodeDto[], gen, freshness);
      }
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
      return this.envelope(
        entries,
        gen,
        freshness,
        {
          complete: !truncated,
          truncated,
          reasons: truncated ? ['page-limit'] : [],
        },
        { limit: clampLimit(limit, DEFAULT_SEARCH_LIMIT) },
      );
    });
  }

  async architectureSummary(
    query?: ArchitectureQuery | number,
  ): Promise<Result<GraphToolResult<ArchitectureSummaryDto>, McpReadError>> {
    const limit = typeof query === 'number' ? query : query?.limit;
    return this.runQuery('architectureSummary', (gen, freshness) => {
      if (gen === undefined) {
        return this.envelope(
          {
            functionCount: 0,
            edgeCount: 0,
            languages: [],
            packages: [],
            hotspots: [],
            ...(this.targetConventions === undefined
              ? {}
              : { targetConventions: this.targetConventions }),
          },
          gen,
          freshness,
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
      return this.envelope(
        {
          functionCount: gen.indexes.byBodyHash.size,
          edgeCount: edgeCount(gen.indexes),
          languages: [gen.catalog.language],
          packages,
          hotspots,
          ...(this.targetConventions === undefined
            ? {}
            : { targetConventions: this.targetConventions }),
        },
        gen,
        freshness,
        {
          complete: packages.length >= rows.length,
          truncated: packages.length < rows.length,
          reasons: packages.length < rows.length ? ['page-limit'] : [],
        },
        { limit: cap },
      );
    });
  }

  private topHotspots(gen: CatalogGeneration, cap: number): BlastDto[] {
    const scores = this.blastScores(gen);
    const ranked: BlastDto[] = [];
    for (const [hash, score] of scores) {
      const occ = gen.indexes.byBodyHash.get(hash);
      if (occ === undefined) continue;
      const symbol = toSymbolRef(occ);
      if (symbol === undefined) continue;
      ranked.push({
        symbol,
        ...score,
        identityMode: 'body-twin-union',
      });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, cap);
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
        outcome: 'failed',
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
      outcome: 'ok',
      durationMs: outcome.value.durationMs,
      priorGenerationAvailable: outcome.value.priorGenerationAvailable,
    });
    return ok(this.envelope(data, gen, freshness));
  }
}

// silence unused import if tree-shaken differently
void toGraphSymbolRef;
void fromGraphReadError;

export { type GraphGeneration } from './graph-read-port.js';
