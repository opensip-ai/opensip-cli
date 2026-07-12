// @fitness-ignore-file file-length-limit -- composition/facade surface retained as a single module for the MCP/CLI audit evidence rollout; split tracked as follow-up.
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { ephemeralProjectCacheKey, err, ok, type Result } from '@opensip-cli/core';
import {
  compileSourceRoleMatcher,
  makeFacet,
  rollupFacets,
  UNREQUESTED_FACET,
  MAX_AUDIT_SOURCE_ROLE_FILES,
} from '@opensip-cli/graph/read';

import { freshnessFromVerification, missingFreshness } from './freshness.js';
import { bindCursor, decodeCursor, encodeCursor, type GroupSummary } from './graph-query-page.js';
import { readError } from './mcp-error.js';

import type { CatalogGeneration, GraphGenerationController } from './catalog-generation.js';
import type { ArchitectureSummaryDto, CatalogStatus } from './graph-read-port.js';
import type { McpReadError } from './mcp-error.js';
import type {
  Freshness,
  GraphCoverage,
  GraphEvidenceContext,
  GraphToolResult,
} from './symbol-dto.js';
import type {
  AuditSourceRolePolicy,
  Catalog,
  GraphSourceFilter,
  SourceRoleMatcher,
} from '@opensip-cli/graph/read';

const CURSOR_VERSION = 1 as const;
const LOG_QUERY_FAILED = 'mcp.graph.query.failed';
const LOG_QUERY_COMPLETED = 'mcp.graph.query.completed';

interface EnvelopeOptions {
  /** Explicit four-facet coverage — required (P2 Phase 2.2). */
  readonly coverage: GraphCoverage;
  readonly page?: { readonly limit: number; readonly nextCursor?: string };
  readonly filter?: GraphSourceFilter;
  readonly groups?: readonly GroupSummary[];
}

/**
 * Complete inventory-only facet coverage for reads that inspected the full
 * candidate set with no truncation reasons (missing catalog, empty result, etc.).
 */
export function completeInventoryCoverage(): GraphCoverage {
  return rollupFacets({
    inventory: makeFacet(true, new Set()),
    evidence: UNREQUESTED_FACET,
    grouping: UNREQUESTED_FACET,
    projection: UNREQUESTED_FACET,
  });
}

/**
 * Inventory facet with explicit reasons (malformed rows, candidate caps, etc.).
 * Other facets remain unrequested.
 */
export function inventoryCoverage(reasons: readonly string[]): GraphCoverage {
  return rollupFacets({
    inventory: makeFacet(true, new Set(reasons)),
    evidence: UNREQUESTED_FACET,
    grouping: UNREQUESTED_FACET,
    projection: UNREQUESTED_FACET,
  });
}

type QueryIdentityMode = 'occurrence' | 'body-twin-union' | 'package' | 'mixed' | 'not-applicable';

interface QueryLogContext {
  readonly identityMode: QueryIdentityMode;
  readonly sourceScope: GraphSourceFilter['sourceScope'];
}

function resultDataCount(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data === undefined || data === null) return 0;
  return 1;
}

/** Unique-ish stream of catalog occurrence file paths (the compiler dedups). */
function* catalogFilePaths(catalog: Catalog): Generator<string> {
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const occ of occs) yield occ.filePath;
  }
}

function projectRelativeConfigPath(projectRoot: string, configPath: string): string {
  if (/\p{Cc}/u.test(configPath)) return '<invalid-config-path>';
  const root = resolve(projectRoot);
  const absolute = resolve(root, configPath);
  const value = relative(root, absolute);
  if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    return '<outside-project>';
  }
  return (value || '.').split(sep).join('/');
}

/** Construction dependencies for the package-internal SQLite query context. */
export interface SqliteGraphQueryContextDeps {
  readonly projectRoot: string;
  readonly configPath?: string;
  /**
   * The plain audit source-role policy resolved from `graph.auditTestSourceGlobs`
   * (P2 Phase 1.4). Absent when no globs are configured. The context echoes this
   * policy on filters and compiles it into a matcher once per generation.
   */
  readonly sourceRolePolicy?: AuditSourceRolePolicy;
  readonly log?: (
    evt: string,
    fields: Record<string, string | number | boolean | undefined>,
  ) => void;
}

/**
 * Shared lifecycle, envelope, cursor, and logging behavior for SQLite graph
 * reads. Query-specific projections remain on {@link SqliteGraphReadPort}.
 */
export class SqliteGraphQueryContext {
  readonly projectKey: string;
  private readonly projectRoot: string;
  private readonly configPath: string;
  private readonly log: SqliteGraphQueryContextDeps['log'];
  private readonly sourceRolePolicy?: AuditSourceRolePolicy;
  /** Per-generation compiled matcher cache (instance-scoped; keyed by g1 identity). */
  private sourceRoleCache?: { readonly generationKey: string; readonly matcher: SourceRoleMatcher };

  constructor(
    private readonly controller: GraphGenerationController,
    deps: SqliteGraphQueryContextDeps,
  ) {
    this.projectRoot = deps.projectRoot;
    this.configPath = projectRelativeConfigPath(
      deps.projectRoot,
      deps.configPath ?? 'opensip-cli.config.yml',
    );
    this.projectKey = ephemeralProjectCacheKey(deps.projectRoot);
    this.log = deps.log;
    this.sourceRolePolicy = deps.sourceRolePolicy;
  }

  /**
   * Compile the audit source-role matcher for a generation (P2 Phase 1.4).
   * Classification runs ONCE per `g1:` identity and is retained on this context
   * instance; a new generation reclassifies its own catalog paths. Fails the
   * read with a typed error when a glob cannot compile or the catalog exceeds
   * MAX_AUDIT_SOURCE_ROLE_FILES. No global/singleton/WeakMap cache.
   */
  sourceRoleMatcherFor(
    gen: CatalogGeneration | undefined,
  ): Result<SourceRoleMatcher, McpReadError> {
    const policy = this.sourceRolePolicy;
    if (gen === undefined || policy === undefined || policy.testGlobs.length === 0) {
      // No configured globs → the no-op matcher (this compile path never fails).
      const empty = compileSourceRoleMatcher(undefined, [], {
        maxFiles: MAX_AUDIT_SOURCE_ROLE_FILES,
      });
      return empty.ok
        ? empty
        : err(readError('graph-source-role-failed', 'Audit source-role setup failed.'));
    }
    if (this.sourceRoleCache?.generationKey === gen.key) {
      return ok(this.sourceRoleCache.matcher);
    }
    const compiled = compileSourceRoleMatcher(policy, catalogFilePaths(gen.catalog), {
      maxFiles: MAX_AUDIT_SOURCE_ROLE_FILES,
    });
    if (!compiled.ok) {
      return err(
        readError(
          'graph-source-role-failed',
          'Audit source-role classification failed for this catalog.',
        ),
      );
    }
    this.sourceRoleCache = { generationKey: gen.key, matcher: compiled.value };
    return ok(compiled.value);
  }

  async runQuery<T>(
    operation: string,
    metadata: QueryLogContext,
    project: (
      gen: CatalogGeneration | undefined,
      freshness: Freshness,
    ) => GraphToolResult<T> | Result<GraphToolResult<T>, McpReadError>,
  ): Promise<Result<GraphToolResult<T>, McpReadError>> {
    const started = Date.now();
    try {
      const captured = await this.controller.capture();
      if (!captured.ok) {
        this.logQueryFailure(operation, started, metadata);
        return captured;
      }
      const gen = captured.value;
      const freshness = await this.freshnessFor(gen);
      if (!freshness.ok) {
        this.logQueryFailure(operation, started, metadata);
        return freshness;
      }
      const projected = project(gen, freshness.value);
      if ('ok' in projected && !projected.ok) {
        this.logQueryFailure(operation, started, metadata);
        return projected;
      }
      const result = 'ok' in projected ? projected.value : projected;
      this.log?.(LOG_QUERY_COMPLETED, {
        operation,
        identityMode: metadata.identityMode,
        sourceScope: metadata.sourceScope,
        resultCount: resultDataCount(result.data),
        coverageComplete: result.coverage.complete,
        coverageTruncated: result.coverage.truncated,
        outcome: 'ok',
        durationMs: Date.now() - started,
      });
      return ok(result);
    } catch {
      this.logQueryFailure(operation, started, metadata);
      return err(
        readError('graph-query-failed', 'Graph query failed due to an infrastructure error.'),
      );
    }
  }

  async freshnessFor(gen: CatalogGeneration | undefined): Promise<Result<Freshness, McpReadError>> {
    if (gen === undefined) return ok(missingFreshness());
    const verified = await this.controller.verifyCurrent(gen);
    if (!verified.ok) return verified;
    return ok(freshnessFromVerification(verified.value, gen.builtAt));
  }

  /**
   * Assemble a graph tool envelope. Coverage is REQUIRED as explicit four-facet
   * {@link GraphCoverage} (P2 Phase 2.2) — no flat default / conversion overload.
   */
  envelope<T>(
    data: T,
    gen: CatalogGeneration | undefined,
    freshness: Freshness,
    options: EnvelopeOptions,
  ): GraphToolResult<T> {
    return {
      data,
      context: this.contextFor(gen),
      freshness,
      ...(options.page === undefined ? {} : { page: options.page }),
      coverage: options.coverage,
      ...(options.filter === undefined ? {} : { filter: options.filter }),
      ...(options.groups === undefined ? {} : { groups: options.groups }),
    };
  }

  /** The plain source-role policy echoed into every resolved filter, when set. */
  private get sourceRolesEcho(): Pick<GraphSourceFilter, 'sourceRoles'> {
    return this.sourceRolePolicy === undefined ? {} : { sourceRoles: this.sourceRolePolicy };
  }

  resolveFilter(
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
      ...this.sourceRolesEcho,
    };
  }

  defaultProductionFilter(partial?: Partial<GraphSourceFilter>): GraphSourceFilter {
    return {
      sourceScope: partial?.sourceScope ?? 'production',
      generated: partial?.generated ?? 'exclude',
      ...(partial?.packages === undefined ? {} : { packages: partial.packages }),
      ...(partial?.filePath === undefined ? {} : { filePath: partial.filePath }),
      ...(partial?.filePrefix === undefined ? {} : { filePrefix: partial.filePrefix }),
      ...(partial?.kinds === undefined ? {} : { kinds: partial.kinds }),
      ...(partial?.visibilities === undefined ? {} : { visibilities: partial.visibilities }),
      ...this.sourceRolesEcho,
    };
  }

  resolveAfterKey(
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

  nextCursorFor(
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

  async catalogStatus(): Promise<Result<CatalogStatus, McpReadError>> {
    const started = Date.now();
    const metadata: QueryLogContext = {
      identityMode: 'not-applicable',
      sourceScope: 'all',
    };
    const captured = await this.controller.capture();
    if (!captured.ok) {
      this.logQueryFailure('catalogStatus', started, metadata);
      return captured;
    }
    const gen = captured.value;
    const freshness = await this.freshnessFor(gen);
    if (!freshness.ok) {
      this.logQueryFailure('catalogStatus', started, metadata);
      return freshness;
    }
    this.log?.(LOG_QUERY_COMPLETED, {
      operation: 'catalogStatus',
      identityMode: metadata.identityMode,
      sourceScope: metadata.sourceScope,
      resultCount: 1,
      coverageComplete: freshness.value.verification === 'complete',
      coverageTruncated: false,
      outcome: 'ok',
      durationMs: Date.now() - started,
    });
    return ok({ context: this.contextFor(gen), freshness: freshness.value });
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

  private logQueryFailure(operation: string, started: number, metadata: QueryLogContext): void {
    this.log?.(LOG_QUERY_FAILED, {
      operation,
      identityMode: metadata.identityMode,
      sourceScope: metadata.sourceScope,
      resultCount: 0,
      coverageComplete: false,
      coverageTruncated: false,
      outcome: 'failed',
      durationMs: Date.now() - started,
    });
  }
}

/** Builds the zero-catalog architecture response with explicit count semantics. */
export function emptyArchitecture(
  filter: GraphSourceFilter,
  sections: readonly ('metrics' | 'packageEdges' | 'hotspots')[] = ['metrics'],
): ArchitectureSummaryDto {
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
      distributionCountUnit: 'resolved-targets-plus-unresolved-call-sites',
      resolvedTargetConfidence: { values: {}, countUnit: 'resolved-targets' },
      resolvedTargetResolution: { values: {}, countUnit: 'resolved-targets' },
      unresolvedCallSiteConfidence: {
        values: {},
        countUnit: 'unresolved-call-sites',
      },
      unresolvedCallSiteResolution: {
        values: {},
        countUnit: 'unresolved-call-sites',
      },
      nodeIdentity: 'occurrence',
      sourceScope: filter.sourceScope,
      generated: filter.generated,
      edgeKind: 'call',
      catalogResolutionMode: 'exact',
    },
    packageCount: {
      value: 0,
      nodeIdentity: 'package',
      sourceScope: filter.sourceScope,
      generated: filter.generated,
    },
    includedSections: sections,
    ...(sections.includes('packageEdges')
      ? {
          packageEdges: [],
          packageEdgesSummary: { totalAvailable: 0, selectedCount: 0, pageReturned: 0 },
        }
      : {}),
    ...(sections.includes('hotspots')
      ? {
          hotspots: [],
          hotspotsSummary: { totalAvailable: 0, selectedCount: 0, pageReturned: 0 },
        }
      : {}),
  };
}
