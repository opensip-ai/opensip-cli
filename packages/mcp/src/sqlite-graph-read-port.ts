/**
 * SQLite-backed {@link GraphReadPort} (ADR-0084 + MCP Graph Audit Phase 1).
 *
 * Composes {@link GraphGenerationController} for lifecycle and owns query
 * projection + evidence-envelope assembly. Passes the injected datastore only
 * to public graph/read functions — never accesses `.db` or graph persistence.
 */

import { err, ok, type LanguageAdapter, type Result } from '@opensip-cli/core';
import {
  buildArchitectureView,
  continuationToken,
  deriveGraphReadFeatures,
  facetsFromFlatCoverage,
  loadCatalogGeneration,
  readCatalogIdentity,
  verifyCatalogInputs,
  type Catalog,
  type AuditSourceRolePolicy,
  type FeatureColumn,
  type FeatureTable,
  type GraphAdapterRegistryReader,
  type GraphConfig,
} from '@opensip-cli/graph/read';

import {
  decodeArchitectureCursorState,
  nextArchitectureAfterKey,
} from './architecture-query-page.js';
import { GraphGenerationController, type CatalogGeneration } from './catalog-generation.js';
import { deadCodeStableKey, pageDeadCode } from './dead-code-page.js';
import { unavailableGraphStatus } from './freshness.js';
import { blastQueryDigest, projectBlastMembers } from './graph-blast-projection.js';
import {
  digestNormalizedQuery,
  rejectCursorWithoutGeneration,
  validateCursorBinding,
} from './graph-query-page.js';
import { clampLimit } from './graph-read-projection.js';
import { projectTraversal } from './graph-traversal-projection.js';
import { fromGraphReadError, readError } from './mcp-error.js';
import { SqliteGraphPackageQueries } from './sqlite-graph-package-queries.js';
import {
  completeInventoryCoverage,
  emptyArchitecture,
  SqliteGraphQueryContext,
} from './sqlite-graph-query-context.js';
import { SqliteGraphSymbolQueries } from './sqlite-graph-symbol-queries.js';

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
  SymbolSearchDto,
  TraversalQuery,
  TraversalSnapshot,
  WhyDependsDto,
  WhyDependsQuery,
} from './graph-read-port.js';
import type { McpReadError } from './mcp-error.js';
import type { GraphToolResult, SymbolRef } from './symbol-dto.js';
import type { DataStore } from '@opensip-cli/datastore';

const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_ARCH_LIMIT = 25;

function toArchitectureSummaryDto(
  view: {
    readonly languages: ArchitectureSummaryDto['languages'];
    readonly occurrenceCount: ArchitectureSummaryDto['occurrenceCount'];
    readonly uniqueBodyCount: ArchitectureSummaryDto['uniqueBodyCount'];
    readonly callEvidence: ArchitectureSummaryDto['callEvidence'];
    readonly packageCount: ArchitectureSummaryDto['packageCount'];
    readonly includedSections: ArchitectureSummaryDto['includedSections'];
    readonly packageEdges?: ArchitectureSummaryDto['packageEdges'];
    readonly packageEdgesSummary?: ArchitectureSummaryDto['packageEdgesSummary'];
    readonly hotspots?: ArchitectureSummaryDto['hotspots'];
    readonly hotspotsSummary?: ArchitectureSummaryDto['hotspotsSummary'];
  },
): ArchitectureSummaryDto {
  return {
    languages: view.languages,
    occurrenceCount: view.occurrenceCount,
    uniqueBodyCount: view.uniqueBodyCount,
    callEvidence: view.callEvidence,
    packageCount: view.packageCount,
    includedSections: view.includedSections,
    ...(view.packageEdges === undefined
      ? {}
      : {
          packageEdges: view.packageEdges,
          ...(view.packageEdgesSummary === undefined
            ? {}
            : { packageEdgesSummary: view.packageEdgesSummary }),
        }),
    ...(view.hotspots === undefined
      ? {}
      : {
          hotspots: view.hotspots,
          ...(view.hotspotsSummary === undefined ? {} : { hotspotsSummary: view.hotspotsSummary }),
        }),
  };
}

/**
 * Resolve the plain audit source-role policy from the validated graph config
 * (P2 Phase 1.4). Returns `{}` (no `sourceRolePolicy` key) when no globs are
 * configured, so the query context echoes nothing and compiles the no-op matcher.
 */
function sourceRolePolicyDep(
  config: GraphConfig,
): { sourceRolePolicy?: AuditSourceRolePolicy } {
  const testGlobs = config.auditTestSourceGlobs ?? [];
  if (testGlobs.length === 0) return {};
  return { sourceRolePolicy: { testGlobs, mode: 'audit-test-globs-v1' } };
}

export interface SqliteGraphReadPortDeps {
  readonly store: DataStore;
  readonly projectRoot: string;
  readonly configPath?: string;
  readonly adapters: GraphAdapterRegistryReader;
  readonly languageAdapters: readonly LanguageAdapter[];
  readonly rebuild: () => Promise<Result<Catalog, McpReadError>>;
  readonly config?: GraphConfig;
  readonly log?: (
    evt: string,
    fields: Record<string, string | number | boolean | undefined>,
  ) => void;
}

export class SqliteGraphReadPort implements GraphReadPort {
  private readonly controller: GraphGenerationController;
  private readonly queryContext: SqliteGraphQueryContext;
  private readonly packageQueries: SqliteGraphPackageQueries;
  private readonly symbolQueries: SqliteGraphSymbolQueries;
  private readonly config: GraphConfig;
  constructor(deps: SqliteGraphReadPortDeps) {
    this.config = deps.config ?? {};
    this.controller = new GraphGenerationController({
      store: deps.store,
      projectRoot: deps.projectRoot,
      adapters: deps.adapters,
      readIdentity: (store) => readCatalogIdentity(store),
      loadCatalog: (store) => loadCatalogGeneration(store),
      verify: (input) =>
        verifyCatalogInputs({
          ...input,
          languageAdapters: deps.languageAdapters,
          graphConfig: deps.config ?? {},
        }),
      rebuild: deps.rebuild,
      log: deps.log,
    });
    this.queryContext = new SqliteGraphQueryContext(this.controller, {
      projectRoot: deps.projectRoot,
      ...(deps.configPath === undefined ? {} : { configPath: deps.configPath }),
      ...sourceRolePolicyDep(this.config),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
    this.packageQueries = new SqliteGraphPackageQueries({
      context: this.queryContext,
      features: (generation) => this.generationFeatures(generation),
    });
    this.symbolQueries = new SqliteGraphSymbolQueries(this.queryContext);
  }

  async catalogStatus(): Promise<Result<CatalogStatus, McpReadError>> {
    return this.queryContext.catalogStatus();
  }

  async resolveSymbolId(
    symbolId: string,
  ): Promise<Result<GraphToolResult<SymbolRef | undefined>, McpReadError>> {
    return this.symbolQueries.resolveSymbolId(symbolId);
  }

  async searchSymbols(
    query: string,
    opts?: SearchSymbolsOptions,
  ): Promise<Result<GraphToolResult<SymbolSearchDto>, McpReadError>> {
    return this.symbolQueries.searchSymbols(query, opts);
  }

  async findBySpan(
    file: string,
    line: number,
  ): Promise<Result<GraphToolResult<readonly SymbolRef[]>, McpReadError>> {
    return this.symbolQueries.findBySpan(file, line);
  }

  async traverse(
    query: TraversalQuery,
  ): Promise<Result<GraphToolResult<TraversalSnapshot>, McpReadError>> {
    const identity = query.identity ?? 'occurrence';
    const filter = this.queryContext.resolveFilter(query.filter, 'discover');
    return this.queryContext.runQuery(
      'traverse',
      { identityMode: identity, sourceScope: filter.sourceScope },
      (gen, freshness) => {
        const matcher = this.queryContext.sourceRoleMatcherFor(gen);
        if (!matcher.ok) return matcher;
        const projected = projectTraversal(
          gen,
          query,
          filter,
          this.queryContext.projectKey,
          matcher.value,
        );
        if (!projected.ok) return projected;
        // Traversal exclusive modes land in Task 2.6; facet-bridge until then.
        return this.queryContext.envelope(projected.value.data, gen, freshness, {
          ...projected.value.options,
          coverage: facetsFromFlatCoverage(projected.value.options.coverage),
        });
      },
    );
  }

  async blast(
    symbolId: string,
    opts?: Parameters<GraphReadPort['blast']>[1],
  ): Promise<Result<GraphToolResult<BlastDto | undefined>, McpReadError>> {
    const filter = this.queryContext.resolveFilter(opts?.filter, 'discover');
    const queryDigest = blastQueryDigest(symbolId, filter, opts?.groupBy ?? 'none');
    return this.queryContext.runQuery(
      'blast',
      { identityMode: 'body-twin-union', sourceScope: filter.sourceScope },
      (gen, freshness) => {
        if (gen === undefined) {
          const cursor = rejectCursorWithoutGeneration(opts?.cursor, {
            projectKey: this.queryContext.projectKey,
            queryDigest,
          });
          if (!cursor.ok) return cursor;
          return this.queryContext.envelope(undefined, gen, freshness, {
            coverage: completeInventoryCoverage(),
          });
        }
        const cursor = validateCursorBinding({
          projectKey: this.queryContext.projectKey,
          generationKey: gen.key,
          queryDigest,
          limit: clampLimit(opts?.limit, DEFAULT_SEARCH_LIMIT),
          ...(opts?.cursor === undefined ? {} : { cursor: opts.cursor }),
        });
        if (!cursor.ok) return cursor;
        const occ = gen.indexes.byOccId.get(symbolId);
        if (occ === undefined) {
          return this.queryContext.envelope(undefined, gen, freshness, {
            coverage: completeInventoryCoverage(),
          });
        }
        const score = this.generationFeatures(gen).function.get(occ.bodyHash)?.blast;
        if (score === undefined) {
          return this.queryContext.envelope(undefined, gen, freshness, {
            coverage: completeInventoryCoverage(),
          });
        }
        const blastMatcher = this.queryContext.sourceRoleMatcherFor(gen);
        if (!blastMatcher.ok) return blastMatcher;
        const projected = projectBlastMembers({
          generation: gen,
          bodyHash: occ.bodyHash,
          symbolId,
          filter,
          matcher: blastMatcher.value,
          options: opts,
          projectKey: this.queryContext.projectKey,
        });
        if (!projected.ok) return projected;
        // Blast exclusive modes land in Task 2.8; facet-bridge until then.
        const options = {
          ...projected.value.options,
          coverage: facetsFromFlatCoverage(projected.value.options.coverage),
        };
        const symbol = projected.value.requested;
        if (symbol === undefined) {
          return this.queryContext.envelope(undefined, gen, freshness, options);
        }
        return this.queryContext.envelope(
          {
            symbol,
            members: projected.value.members,
            totalMembership: projected.value.totalMembership,
            ...score,
            identityMode: 'body-twin-union',
            twinCount: projected.value.twinCount,
            ...(projected.value.filteringLimitations.length === 0
              ? {}
              : { filteringLimitations: projected.value.filteringLimitations }),
          },
          gen,
          freshness,
          options,
        );
      },
    );
  }

  private generationFeatures(gen: CatalogGeneration): FeatureTable {
    if (gen.derived.features !== undefined) return gen.derived.features;
    const columns: readonly FeatureColumn[] = ['blast', 'packageCoupling', 'reachableFromEntry'];
    const features = deriveGraphReadFeatures(gen.catalog, gen.indexes, this.config, columns);
    gen.derived.features = features;
    return features;
  }

  async deadCode(
    query?: DeadCodeQuery,
  ): Promise<Result<GraphToolResult<readonly DeadCodeDto[]>, McpReadError>> {
    const limit = clampLimit(query?.limit, DEFAULT_SEARCH_LIMIT);
    const filter = this.queryContext.resolveFilter(query?.filter, 'discover');
    const groupBy = query?.groupBy ?? 'none';
    const queryDigest = digestNormalizedQuery({
      op: 'deadCode',
      filter,
      groupBy,
    });
    return this.queryContext.runQuery(
      'deadCode',
      { identityMode: 'occurrence', sourceScope: filter.sourceScope },
      (gen, freshness) => {
        if (gen === undefined) {
          const cursor = rejectCursorWithoutGeneration(query?.cursor, {
            projectKey: this.queryContext.projectKey,
            queryDigest,
          });
          if (!cursor.ok) return cursor;
          return this.queryContext.envelope([] as readonly DeadCodeDto[], gen, freshness, {
            coverage: completeInventoryCoverage(),
            page: { limit },
            filter,
          });
        }
        const binding = {
          projectKey: this.queryContext.projectKey,
          generationKey: gen.key,
          queryDigest,
        };
        const after = this.queryContext.resolveAfterKey(query?.cursor, binding);
        if (!after.ok) return after;
        const deadCodeMatcher = this.queryContext.sourceRoleMatcherFor(gen);
        if (!deadCodeMatcher.ok) return deadCodeMatcher;
        const page = pageDeadCode({
          generation: gen,
          config: this.config,
          filter,
          matcher: deadCodeMatcher.value,
          limit,
          afterKey: after.value,
          groupBy,
          cachedFeatures: this.generationFeatures(gen),
        });
        if (!page.anchorFound) {
          return err(readError('cursor-invalid', 'Cursor continuation anchor is invalid.'));
        }
        const last = page.rows.at(-1);
        const nextCursor =
          page.hasMore && last !== undefined
            ? this.queryContext.nextCursorFor(binding, continuationToken(deadCodeStableKey(last)))
            : undefined;
        // Dead-code exclusive modes land in Task 2.8; facet-bridge until then.
        return this.queryContext.envelope(page.rows, gen, freshness, {
          coverage: facetsFromFlatCoverage(page.coverage),
          page: { limit, ...(nextCursor === undefined ? {} : { nextCursor }) },
          filter,
          ...(page.groups === undefined ? {} : { groups: page.groups }),
        });
      },
    );
  }

  async architectureSummary(
    query?: ArchitectureQuery,
  ): Promise<Result<GraphToolResult<ArchitectureSummaryDto>, McpReadError>> {
    const limit = clampLimit(query?.limit, DEFAULT_ARCH_LIMIT);
    const filter = this.queryContext.resolveFilter(query?.filter, 'production');
    const groupBy = query?.groupBy ?? 'none';
    const sections = query?.sections ?? (['metrics'] as const);
    const topN = query?.topN ?? 20;
    const queryDigest = digestNormalizedQuery({
      op: 'architectureSummary',
      filter,
      groupBy,
      sections,
      topN,
    });
    return this.queryContext.runQuery(
      'architectureSummary',
      { identityMode: 'mixed', sourceScope: filter.sourceScope },
      (gen, freshness) =>
        this.projectArchitectureSummary({
          gen,
          freshness,
          filter,
          limit,
          groupBy,
          sections,
          topN,
          queryDigest,
          cursor: query?.cursor,
        }),
    );
  }

  private projectArchitectureSummary(input: {
    readonly gen: CatalogGeneration | undefined;
    readonly freshness: GraphToolResult<unknown>['freshness'];
    readonly filter: ReturnType<SqliteGraphQueryContext['resolveFilter']>;
    readonly limit: number;
    readonly groupBy: 'none' | 'package' | 'file';
    readonly sections: ArchitectureSummaryDto['includedSections'];
    readonly topN: number;
    readonly queryDigest: string;
    readonly cursor: string | undefined;
  }): Result<GraphToolResult<ArchitectureSummaryDto>, McpReadError> {
    const { gen, freshness, filter, limit, groupBy, sections, topN, queryDigest, cursor } = input;
    if (gen === undefined) {
      const missing = rejectCursorWithoutGeneration(cursor, {
        projectKey: this.queryContext.projectKey,
        queryDigest,
      });
      if (!missing.ok) return missing;
      return ok(
        this.queryContext.envelope(emptyArchitecture(filter, sections), gen, freshness, {
          coverage: completeInventoryCoverage(),
          page: { limit },
          filter,
        }),
      );
    }
    const binding = {
      projectKey: this.queryContext.projectKey,
      generationKey: gen.key,
      queryDigest,
    };
    const after = this.queryContext.resolveAfterKey(cursor, binding);
    if (!after.ok) return after;
    const cursorState = decodeArchitectureCursorState(after.value);
    if (!cursorState.ok) return cursorState;
    const matcher = this.queryContext.sourceRoleMatcherFor(gen);
    if (!matcher.ok) return matcher;
    const view = buildArchitectureView(
      gen.catalog,
      gen.indexes,
      {
        filter,
        limit,
        groupBy,
        sections,
        topN,
        ...(cursorState.value.packageEdgeKey === undefined
          ? {}
          : { afterPackageEdgeKey: cursorState.value.packageEdgeKey }),
        ...(cursorState.value.hotspotKey === undefined
          ? {}
          : { afterHotspotKey: cursorState.value.hotspotKey }),
        packageEdgesDone: cursorState.value.packageEdgesDone,
        hotspotsDone: cursorState.value.hotspotsDone,
      },
      matcher.value,
      this.generationFeatures(gen),
    );
    if (!view.ok) return err(fromGraphReadError(view.error));
    const nextAfterKey = nextArchitectureAfterKey(cursorState.value, view.value);
    const nextCursor =
      nextAfterKey === undefined ? undefined : this.queryContext.nextCursorFor(binding, nextAfterKey);
    return ok(
      this.queryContext.envelope(toArchitectureSummaryDto(view.value), gen, freshness, {
        coverage: facetsFromFlatCoverage(view.value.coverage),
        page: { limit, ...(nextCursor === undefined ? {} : { nextCursor }) },
        filter: view.value.effectiveFilter,
        ...(view.value.groups === undefined ? {} : { groups: view.value.groups }),
      }),
    );
  }

  async packageDependencies(
    query: PackageDependenciesQuery,
  ): Promise<Result<GraphToolResult<PackageDependenciesDto>, McpReadError>> {
    return this.packageQueries.packageDependencies(query);
  }

  async whyDepends(
    query: WhyDependsQuery,
  ): Promise<Result<GraphToolResult<WhyDependsDto>, McpReadError>> {
    return this.packageQueries.whyDepends(query);
  }

  async packageCycles(
    query: PackageCyclesQuery,
  ): Promise<Result<GraphToolResult<PackageCyclesDto>, McpReadError>> {
    return this.packageQueries.packageCycles(query);
  }

  async refresh(opts?: {
    forceRebuild?: boolean;
  }): Promise<Result<GraphToolResult<RefreshResult>, McpReadError>> {
    const outcome = await this.controller.refresh(opts?.forceRebuild === true);
    if (!outcome.ok) return outcome;
    const gen = outcome.value.generation;
    const verifiedFreshness = await this.queryContext.freshnessFor(gen);
    if (!verifiedFreshness.ok && outcome.value.action !== 'rebuilt') return verifiedFreshness;
    const freshness = verifiedFreshness.ok
      ? verifiedFreshness.value
      : { ...unavailableGraphStatus(), builtAt: gen.builtAt };
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
    return ok(
      this.queryContext.envelope(data, gen, freshness, {
        coverage: completeInventoryCoverage(),
      }),
    );
  }
}

export { type GraphGeneration } from './graph-read-port.js';
