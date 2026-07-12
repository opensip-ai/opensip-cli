import { err, type Result } from '@opensip-cli/core';
import {
  buildPackageEvidence,
  buildPackageScc,
  compareCodePointStrings,
  makeFacet,
  mergeFacet,
  packageDependencyStableKey,
  rollupFacets,
  UNREQUESTED_FACET,
  type FeatureTable,
  type GraphReadFacetCoverage,
  type PackageCallEvidenceRow,
  type PackageEvidenceView,
  type PackageImportEvidenceRow,
} from '@opensip-cli/graph/read';

import { digestNormalizedQuery, rejectCursorWithoutGeneration } from './graph-query-page.js';
import { clampLimit } from './graph-read-projection.js';
import { fromGraphReadError } from './mcp-error.js';
import {
  pagePackageCycles,
  pagePackageDependencies,
  pageWhyDepends,
} from './package-query-page.js';
import {
  completeInventoryCoverage,
  type SqliteGraphQueryContext,
} from './sqlite-graph-query-context.js';

import type { CatalogGeneration } from './catalog-generation.js';
import type {
  PackageCyclesDto,
  PackageCyclesQuery,
  PackageDependenciesDto,
  PackageDependenciesQuery,
  WhyDependsDto,
  WhyDependsQuery,
} from './graph-read-port.js';
import type { McpReadError } from './mcp-error.js';
import type { GraphCoverage, GraphToolResult } from './symbol-dto.js';

const DEFAULT_SEARCH_LIMIT = 100;

/** Merge grouping/projection facets over package inventory+evidence coverage. */
function withPageFacets(
  coverage: GraphReadFacetCoverage,
  groupTruncated: boolean,
): GraphCoverage {
  return rollupFacets({
    inventory: coverage.inventory,
    evidence: coverage.evidence,
    grouping: mergeFacet(
      coverage.grouping,
      makeFacet(true, new Set(groupTruncated ? ['group-key-cap'] : [])),
    ),
    projection: mergeFacet(coverage.projection, makeFacet(true, new Set())),
  });
}

function mergePackageRows<T extends PackageCallEvidenceRow | PackageImportEvidenceRow>(
  rows: readonly T[],
): T[] {
  const unique = new Map<string, T>();
  for (const row of rows) unique.set(packageDependencyStableKey(row), row);
  return [...unique.values()].sort((left, right) =>
    compareCodePointStrings(packageDependencyStableKey(left), packageDependencyStableKey(right)),
  );
}

function mergeFacetCoverage(coverages: readonly GraphReadFacetCoverage[]): GraphReadFacetCoverage {
  if (coverages.length === 0) {
    return rollupFacets({
      inventory: makeFacet(true, new Set()),
      evidence: UNREQUESTED_FACET,
      grouping: UNREQUESTED_FACET,
      projection: UNREQUESTED_FACET,
    });
  }
  return coverages.reduce((acc, next) =>
    rollupFacets({
      inventory: mergeFacet(acc.inventory, next.inventory),
      evidence: mergeFacet(acc.evidence, next.evidence),
      grouping: mergeFacet(acc.grouping, next.grouping),
      projection: mergeFacet(acc.projection, next.projection),
    }),
  );
}

function packageSelectors(
  packageName: string | undefined,
  direction: 'out' | 'in' | 'both',
): readonly { readonly fromPackage?: string; readonly toPackage?: string }[] {
  if (packageName === undefined) return [{}];
  if (direction === 'both') return [{ fromPackage: packageName }, { toPackage: packageName }];
  if (direction === 'in') return [{ toPackage: packageName }];
  return [{ fromPackage: packageName }];
}

/** Dependencies for the package-oriented SQLite graph query collaborator. */
export interface SqliteGraphPackageQueriesDeps {
  readonly context: SqliteGraphQueryContext;
  readonly features: (generation: CatalogGeneration) => FeatureTable;
}

/** Implements bounded package dependency, proof, and SCC read operations. */
export class SqliteGraphPackageQueries {
  constructor(private readonly deps: SqliteGraphPackageQueriesDeps) {}

  async packageDependencies(
    query: PackageDependenciesQuery,
  ): Promise<Result<GraphToolResult<PackageDependenciesDto>, McpReadError>> {
    const edgeKind = query.edgeKind ?? 'call';
    const direction = query.direction ?? 'out';
    const filter = this.deps.context.defaultProductionFilter(query.filter);
    const groupBy = query.groupBy ?? 'none';
    const limit = clampLimit(query.limit, DEFAULT_SEARCH_LIMIT);
    const sampleLimit = query.sampleLimit;
    const queryDigest = digestNormalizedQuery({
      op: 'packageDependencies',
      edgeKind,
      direction,
      package: query.package,
      filter,
      groupBy,
      sampleLimit: sampleLimit ?? null,
    });
    return this.deps.context.runQuery(
      'packageDependencies',
      { identityMode: 'package', sourceScope: filter.sourceScope },
      (gen, freshness) => {
        if (gen === undefined) {
          const cursor = rejectCursorWithoutGeneration(query.cursor, {
            projectKey: this.deps.context.projectKey,
            queryDigest,
          });
          if (!cursor.ok) return cursor;
          return this.deps.context.envelope({ edgeKind, calls: [], imports: [] }, gen, freshness, {
            coverage: completeInventoryCoverage(),
            page: { limit },
            filter,
          });
        }
        const matcher = this.deps.context.sourceRoleMatcherFor(gen);
        if (!matcher.ok) return matcher;
        const views: PackageEvidenceView[] = [];
        for (const selector of packageSelectors(query.package, direction)) {
          const view = buildPackageEvidence(
            gen.catalog,
            gen.indexes,
            {
              edgeKind,
              filter,
              ...selector,
              ...(sampleLimit === undefined ? {} : { sampleLimit }),
            },
            matcher.value,
            this.deps.features(gen),
          );
          if (!view.ok) return err(fromGraphReadError(view.error));
          views.push(view.value);
        }
        const calls = mergePackageRows(views.flatMap((view) => view.calls));
        const imports = mergePackageRows(views.flatMap((view) => view.imports));
        const coverage = mergeFacetCoverage(views.map((view) => view.coverage));
        const page = pagePackageDependencies(
          [...calls, ...imports],
          {
            projectKey: this.deps.context.projectKey,
            generationKey: gen.key,
            queryDigest,
            limit,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          },
          groupBy,
        );
        if (!page.ok) return page;
        return this.deps.context.envelope(
          {
            edgeKind,
            calls: page.value.rows.filter((row) => row.kind === 'call'),
            imports: page.value.rows.filter((row) => row.kind === 'import'),
          },
          gen,
          freshness,
          {
            coverage: withPageFacets(coverage, page.value.groupTruncated),
            page: {
              limit,
              ...(page.value.nextCursor === undefined ? {} : { nextCursor: page.value.nextCursor }),
            },
            filter,
            ...(page.value.groups === undefined ? {} : { groups: page.value.groups }),
          },
        );
      },
    );
  }

  async whyDepends(
    query: WhyDependsQuery,
  ): Promise<Result<GraphToolResult<WhyDependsDto>, McpReadError>> {
    const edgeKind = query.edgeKind ?? 'combined';
    const filter = this.deps.context.defaultProductionFilter(query.filter);
    const groupBy = query.groupBy ?? 'none';
    const limit = clampLimit(query.limit, DEFAULT_SEARCH_LIMIT);
    const evidenceLimit = query.evidenceLimit;
    const queryDigest = digestNormalizedQuery({
      op: 'whyDepends',
      edgeKind,
      fromPackage: query.fromPackage,
      toPackage: query.toPackage,
      filter,
      groupBy,
      evidenceLimit: evidenceLimit ?? null,
    });
    return this.deps.context.runQuery(
      'whyDepends',
      { identityMode: 'occurrence', sourceScope: filter.sourceScope },
      (gen, freshness) => {
        if (gen === undefined) {
          const cursor = rejectCursorWithoutGeneration(query.cursor, {
            projectKey: this.deps.context.projectKey,
            queryDigest,
          });
          if (!cursor.ok) return cursor;
          return this.deps.context.envelope(
            { edgeKind, calls: [], imports: [], totalMatchingEvidence: 0 },
            gen,
            freshness,
            { coverage: completeInventoryCoverage(), page: { limit }, filter },
          );
        }
        const matcher = this.deps.context.sourceRoleMatcherFor(gen);
        if (!matcher.ok) return matcher;
        const view = buildPackageEvidence(
          gen.catalog,
          gen.indexes,
          {
            edgeKind,
            filter,
            fromPackage: query.fromPackage,
            toPackage: query.toPackage,
            ...(evidenceLimit === undefined ? {} : { evidenceLimit }),
          },
          matcher.value,
          this.deps.features(gen),
        );
        if (!view.ok) return err(fromGraphReadError(view.error));
        const page = pageWhyDepends(
          [...view.value.callEvidence, ...view.value.importEvidence],
          {
            projectKey: this.deps.context.projectKey,
            generationKey: gen.key,
            queryDigest,
            limit,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          },
          groupBy,
        );
        if (!page.ok) return page;
        return this.deps.context.envelope(
          {
            edgeKind,
            calls: page.value.rows.filter((row) => row.kind === 'call'),
            imports: page.value.rows.filter((row) => row.kind === 'import'),
            totalMatchingEvidence: view.value.totalCallEvidence + view.value.totalImportEvidence,
          },
          gen,
          freshness,
          {
            coverage: withPageFacets(view.value.coverage, page.value.groupTruncated),
            page: {
              limit,
              ...(page.value.nextCursor === undefined ? {} : { nextCursor: page.value.nextCursor }),
            },
            filter,
            ...(page.value.groups === undefined ? {} : { groups: page.value.groups }),
          },
        );
      },
    );
  }

  async packageCycles(
    query: PackageCyclesQuery,
  ): Promise<Result<GraphToolResult<PackageCyclesDto>, McpReadError>> {
    const edgeKind = query.edgeKind ?? 'call';
    const filter = this.deps.context.defaultProductionFilter(query.filter);
    const groupBy = query.groupBy ?? 'none';
    const limit = clampLimit(query.limit, DEFAULT_SEARCH_LIMIT);
    const proofLimit = query.proofLimit;
    const queryDigest = digestNormalizedQuery({
      op: 'packageCycles',
      edgeKind,
      filter,
      groupBy,
      proofLimit: proofLimit ?? null,
    });
    return this.deps.context.runQuery(
      'packageCycles',
      { identityMode: 'package', sourceScope: filter.sourceScope },
      (gen, freshness) => {
        if (gen === undefined) {
          const cursor = rejectCursorWithoutGeneration(query.cursor, {
            projectKey: this.deps.context.projectKey,
            queryDigest,
          });
          if (!cursor.ok) return cursor;
          return this.deps.context.envelope({ edgeKind, components: [] }, gen, freshness, {
            coverage: completeInventoryCoverage(),
            page: { limit },
            filter,
          });
        }
        const matcher = this.deps.context.sourceRoleMatcherFor(gen);
        if (!matcher.ok) return matcher;
        const view = buildPackageScc(
          gen.catalog,
          gen.indexes,
          {
            edgeKind,
            filter,
            // proofLimit maps onto evidenceLimit for the SCC proof sample bound.
            ...(proofLimit === undefined ? {} : { evidenceLimit: proofLimit }),
          },
          matcher.value,
          this.deps.features(gen),
        );
        if (!view.ok) return err(fromGraphReadError(view.error));
        const components = view.value.components.map((component) => ({
          packages: component.packages,
          proofEdges: component.proofEdges,
          totalProofEdges: component.totalProofEdges,
        }));
        const page = pagePackageCycles(
          components,
          {
            projectKey: this.deps.context.projectKey,
            generationKey: gen.key,
            queryDigest,
            limit,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          },
          groupBy,
        );
        if (!page.ok) return page;
        return this.deps.context.envelope(
          { edgeKind, components: page.value.rows },
          gen,
          freshness,
          {
            coverage: withPageFacets(view.value.coverage, page.value.groupTruncated),
            page: {
              limit,
              ...(page.value.nextCursor === undefined ? {} : { nextCursor: page.value.nextCursor }),
            },
            filter,
            ...(page.value.groups === undefined ? {} : { groups: page.value.groups }),
          },
        );
      },
    );
  }
}
