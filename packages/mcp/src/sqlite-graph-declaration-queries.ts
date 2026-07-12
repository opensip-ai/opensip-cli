// @fitness-ignore-file file-length-limit -- composition/facade surface retained as a single module for the MCP/CLI audit evidence rollout; split tracked as follow-up.
/**
 * SQLite-backed declaration + cross-file reference queries (P2 Phase 3 Task 3.7).
 *
 * Captures one catalog generation per operation and calls public
 * `@opensip-cli/graph/read` views once. Exclusive compact detail modes.
 */

import { err, ok, type Result } from '@opensip-cli/core';
import {
  compareCodePointStrings,
  compareDeclarationRefs,
  compareReferenceSites,
  declarationStableKey,
  makeFacet,
  referenceStableKey,
  referencesToDeclaration,
  rollupFacets,
  searchDeclarationFacts,
  UNREQUESTED_FACET,
  type DeclarationRef,
  type GraphReadFacetCoverage,
  type GraphSourceFilter,
  type ReferenceSiteRef,
} from '@opensip-cli/graph/read';

import {
  digestNormalizedQuery,
  groupRows,
  pageRows,
  rejectCursorWithoutGeneration,
} from './graph-query-page.js';
import {
  DEFAULT_IDENTITY_SEARCH_LIMIT,
  type CompactQueryDetail,
  type DeclarationRefDto,
  type DeclarationSearchDto,
  type ReferencesToDto,
  type ReferencesToOptions,
  type ReferenceSiteDto,
  type SearchDeclarationsOptions,
} from './graph-read-port.js';
import { clampLimit } from './graph-read-projection.js';
import { readError } from './mcp-error.js';
import {
  completeInventoryCoverage,
  type SqliteGraphQueryContext,
} from './sqlite-graph-query-context.js';
import {
  DEFAULT_STATIC_HANDLER_BRIDGE_LIMITS,
  dedupeStaticHandlerRefs,
  matchStaticHandlerCandidates,
  MAX_STATIC_HANDLER_CACHE_ENTRIES,
  MAX_STATIC_HANDLER_DESCRIPTORS,
  preflightStaticHandlerRef,
  type DeclarationCandidate,
  type StaticHandlerBridgeOutcome,
  type StaticHandlerRef,
} from './static-handler-bridge.js';

import type { CatalogGeneration } from './catalog-generation.js';
import type { McpReadError } from './mcp-error.js';
import type { GraphToolResult } from './symbol-dto.js';

/** Shared 100-row default for references_to (not identity search). */
const DEFAULT_REFERENCE_LIMIT = 100;
/** Max inventory rows retained for exclusive projection (matches page max). */
const MAX_INVENTORY = 500;

/** Grouping mode for declaration-search rollups. */
type DeclarationGroupBy = 'none' | 'package' | 'file';
/** Catalog load status recorded on a static-handler cache entry. */
type CatalogLoadStatus = 'loaded' | 'missing' | 'unsupported';

/** Reason code stamped on every invalid-query read error from this port. */
const INVALID_QUERY = 'invalid-query';
/** Reference scope stamped on every declaration/reference DTO from this port. */
const CROSS_FILE_SCOPE = 'cross-file' as const;

function validateDetail(
  detail: CompactQueryDetail,
  groupBy: DeclarationGroupBy,
): Result<void, McpReadError> {
  if (detail === 'groups' && groupBy === 'none') {
    return err(readError(INVALID_QUERY, 'detail=groups requires groupBy package or file.'));
  }
  if ((detail === 'summary' || detail === 'nodes') && groupBy !== 'none') {
    return err(
      readError(
        INVALID_QUERY,
        'detail=summary and detail=nodes require groupBy none (or omit groupBy).',
      ),
    );
  }
  return ok(undefined);
}

function toDeclarationDto(ref: DeclarationRef): DeclarationRefDto {
  return {
    declarationId: ref.declarationId,
    name: ref.name,
    qualifiedName: ref.qualifiedName,
    kind: ref.kind,
    package: ref.package,
    filePath: ref.filePath,
    line: ref.line,
    column: ref.column,
    endLine: ref.endLine,
    endColumn: ref.endColumn,
    visibility: ref.visibility,
    exportRole: ref.exportRole,
    inTestFile: ref.inTestFile,
    definedInGenerated: ref.definedInGenerated,
  };
}

function toReferenceDto(ref: ReferenceSiteRef): ReferenceSiteDto {
  return {
    referenceId: ref.referenceId,
    kind: ref.kind,
    filePath: ref.filePath,
    line: ref.line,
    column: ref.column,
    endLine: ref.endLine,
    endColumn: ref.endColumn,
    package: ref.package,
    ...(ref.targetDeclarationId === undefined
      ? {}
      : { targetDeclarationId: ref.targetDeclarationId }),
    ...(ref.targetPackage === undefined ? {} : { targetPackage: ref.targetPackage }),
    ...(ref.targetName === undefined ? {} : { targetName: ref.targetName }),
    ...(ref.targetKind === undefined ? {} : { targetKind: ref.targetKind }),
    basis: ref.basis,
    confidence: ref.confidence,
    ...(ref.importSpecifier === undefined ? {} : { importSpecifier: ref.importSpecifier }),
    ...(ref.reason === undefined ? {} : { reason: ref.reason }),
    inTestFile: ref.inTestFile,
    definedInGenerated: ref.definedInGenerated,
  };
}

interface StaticHandlerCacheEntry {
  readonly runtimeSnapshotKey: string;
  readonly catalogIdentity: string;
  readonly catalogStatus: CatalogLoadStatus;
  readonly outcomes: readonly StaticHandlerBridgeOutcome[];
}

/** Implements paged declaration search, references-to, and static-handler bridge. */
export class SqliteGraphDeclarationQueries {
  private readonly staticHandlerCache: StaticHandlerCacheEntry[] = [];

  constructor(private readonly context: SqliteGraphQueryContext) {}

  /**
   * Batch-join author-declared static handlers to declaration facts.
   * Captures one catalog generation, caches completed successes by w1:+g1:.
   */
  async resolveStaticHandlerDeclarations(
    runtimeSnapshotKey: string,
    refs: readonly StaticHandlerRef[],
  ): Promise<
    Result<
      {
        readonly catalogIdentity?: string;
        readonly catalogStatus: CatalogLoadStatus;
        readonly outcomes: readonly StaticHandlerBridgeOutcome[];
      },
      McpReadError
    >
  > {
    if (typeof runtimeSnapshotKey !== 'string' || !runtimeSnapshotKey.startsWith('w1:')) {
      return err(readError(INVALID_QUERY, 'runtimeSnapshotKey must be a validated w1: identity.'));
    }
    if (refs.length > MAX_STATIC_HANDLER_DESCRIPTORS) {
      return err(
        readError(
          INVALID_QUERY,
          `static handler batch exceeds maxDescriptors (${String(MAX_STATIC_HANDLER_DESCRIPTORS)}).`,
        ),
      );
    }

    interface BridgeBatchPayload {
      readonly catalogStatus: CatalogLoadStatus;
      readonly catalogIdentity?: string;
      readonly outcomes: readonly StaticHandlerBridgeOutcome[];
    }

    // Capture generation first (auto-swap visible on next get_runtime_wiring).
    const captured = await this.context.runQuery<BridgeBatchPayload>(
      'resolveStaticHandlerDeclarations',
      { identityMode: 'occurrence', sourceScope: 'all' },
      (gen, freshness) => {
        if (gen === undefined) {
          return this.context.envelope(
            {
              catalogStatus: 'missing' as const,
              outcomes: [] as readonly StaticHandlerBridgeOutcome[],
            },
            gen,
            freshness,
            { coverage: completeInventoryCoverage() },
          );
        }
        const bundle = gen.catalog.semanticFacts;
        if (bundle === undefined) {
          return this.context.envelope(
            {
              catalogStatus: 'unsupported' as const,
              catalogIdentity: gen.key,
              outcomes: [] as readonly StaticHandlerBridgeOutcome[],
            },
            gen,
            freshness,
            { coverage: completeInventoryCoverage() },
          );
        }
        const candidates: DeclarationCandidate[] = bundle.declarations.map((d) => ({
          declarationId: d.declarationId,
          package: d.package,
          filePath: d.filePath,
          name: d.name,
          qualifiedName: d.qualifiedName,
        }));
        const unique = dedupeStaticHandlerRefs(refs, DEFAULT_STATIC_HANDLER_BRIDGE_LIMITS);
        const outcomes = unique.map((ref) => {
          const preflight = preflightStaticHandlerRef(ref);
          if (preflight !== undefined) return preflight;
          return matchStaticHandlerCandidates(
            ref,
            candidates,
            DEFAULT_STATIC_HANDLER_BRIDGE_LIMITS,
          );
        });
        return this.context.envelope(
          {
            catalogStatus: 'loaded' as const,
            catalogIdentity: gen.key,
            outcomes,
          },
          gen,
          freshness,
          { coverage: completeInventoryCoverage() },
        );
      },
    );

    if (!captured.ok) return captured;

    const data: BridgeBatchPayload = captured.value.data;
    // Expand outcomes to one per input ref (preserve caller order).
    const byKey = new Map<string, StaticHandlerBridgeOutcome>();
    for (const outcome of data.outcomes) {
      byKey.set(`${outcome.ref.package}\0${outcome.ref.path}\0${outcome.ref.declaration}`, outcome);
    }
    const ordered: StaticHandlerBridgeOutcome[] = refs.map((ref) => {
      const key = `${ref.package}\0${ref.path}\0${ref.declaration}`;
      const hit = byKey.get(key);
      if (hit !== undefined) return { ...hit, ref };
      if (data.catalogStatus === 'missing') {
        return {
          ref,
          status: 'catalog-missing' as const,
          claimProvenance: 'author-declared' as const,
          matchBasis: 'author-declared-exact-declaration' as const,
          confidence: 'low' as const,
        };
      }
      if (data.catalogStatus === 'unsupported') {
        return {
          ref,
          status: 'declarations-unsupported' as const,
          claimProvenance: 'author-declared' as const,
          matchBasis: 'author-declared-exact-declaration' as const,
          confidence: 'low' as const,
        };
      }
      return {
        ref,
        status: 'not-found' as const,
        claimProvenance: 'author-declared' as const,
        matchBasis: 'author-declared-exact-declaration' as const,
        confidence: 'low' as const,
      };
    });

    const result = {
      catalogIdentity: data.catalogIdentity,
      catalogStatus: data.catalogStatus,
      outcomes: ordered,
    };

    // Cache completed successes only; prune older g1: for same w1:; FIFO at 5.
    if (
      data.catalogStatus === 'loaded' &&
      data.catalogIdentity !== undefined &&
      ordered.every(
        (o) =>
          o.status === 'resolved' ||
          o.status === 'not-found' ||
          o.status === 'ambiguous' ||
          o.status === 'provenance-mismatch' ||
          o.status === 'candidate-cap' ||
          o.status === 'metadata-missing',
      )
    ) {
      this.insertStaticHandlerCache({
        runtimeSnapshotKey,
        catalogIdentity: data.catalogIdentity,
        catalogStatus: data.catalogStatus,
        outcomes: ordered,
      });
    }

    // Serve from cache when available (after insert this is a hit for retries).
    const cached = this.staticHandlerCache.find(
      (entry) =>
        entry.runtimeSnapshotKey === runtimeSnapshotKey &&
        entry.catalogIdentity === data.catalogIdentity,
    );
    if (cached !== undefined && data.catalogIdentity !== undefined) {
      return ok({
        catalogIdentity: cached.catalogIdentity,
        catalogStatus: cached.catalogStatus,
        outcomes: cached.outcomes,
      });
    }

    return ok(result);
  }

  private insertStaticHandlerCache(entry: StaticHandlerCacheEntry): void {
    // Prune older g1: entries for the same w1: after a generation swap.
    for (let i = this.staticHandlerCache.length - 1; i >= 0; i--) {
      const existing = this.staticHandlerCache[i];
      if (
        existing?.runtimeSnapshotKey === entry.runtimeSnapshotKey &&
        existing.catalogIdentity !== entry.catalogIdentity
      ) {
        this.staticHandlerCache.splice(i, 1);
      }
    }
    const dup = this.staticHandlerCache.findIndex(
      (e) =>
        e.runtimeSnapshotKey === entry.runtimeSnapshotKey &&
        e.catalogIdentity === entry.catalogIdentity,
    );
    if (dup >= 0) {
      this.staticHandlerCache[dup] = entry;
      return;
    }
    this.staticHandlerCache.push(entry);
    while (this.staticHandlerCache.length > MAX_STATIC_HANDLER_CACHE_ENTRIES) {
      this.staticHandlerCache.shift();
    }
  }

  async searchDeclarations(
    query: string,
    opts?: SearchDeclarationsOptions,
  ): Promise<Result<GraphToolResult<DeclarationSearchDto>, McpReadError>> {
    const filter = this.context.resolveFilter(opts?.filter, 'discover');
    const limit = clampLimit(opts?.limit, DEFAULT_IDENTITY_SEARCH_LIMIT);
    const match = opts?.match ?? 'substring';
    const groupBy = opts?.groupBy ?? 'none';
    const detail: CompactQueryDetail = opts?.detail ?? 'nodes';
    const detailOk = validateDetail(detail, groupBy);
    if (!detailOk.ok) return detailOk;

    const queryDigest = digestNormalizedQuery({
      op: 'searchDeclarations',
      query,
      match,
      kinds: opts?.kinds ?? null,
      filter,
      groupBy,
      detail,
      referenceScope: CROSS_FILE_SCOPE,
    });

    return this.context.runQuery(
      'searchDeclarations',
      { identityMode: 'occurrence', sourceScope: filter.sourceScope },
      (gen, freshness) => {
        if (gen === undefined) {
          const cursor = rejectCursorWithoutGeneration(opts?.cursor, {
            projectKey: this.context.projectKey,
            queryDigest,
          });
          if (!cursor.ok) return cursor;
          return this.context.envelope(emptyDeclarationDto(detail), gen, freshness, {
            coverage: completeInventoryCoverage(),
            page: { limit },
            filter,
          });
        }

        const matcher = this.context.sourceRoleMatcherFor(gen);
        if (!matcher.ok) return matcher;

        // One public view call: inventory capped at MAX_INVENTORY for projection.
        const view = searchDeclarationFacts(
          gen.catalog,
          {
            query,
            match,
            filter,
            limit: MAX_INVENTORY,
            ...(opts?.kinds === undefined ? {} : { kinds: opts.kinds }),
          },
          matcher.value,
        );
        if (!view.ok) {
          return err(readError(INVALID_QUERY, view.error.message));
        }

        const inventory = [...view.value.declarations].sort(compareDeclarationRefs);
        const totalMatches = view.value.totalMatches;
        // View page is capped at MAX_INVENTORY; when more matches exist the
        // exclusive projection inventory is partial (honest facet).
        const coverage =
          totalMatches > inventory.length
            ? {
                ...view.value.coverage,
                inventory: makeFacet(
                  true,
                  new Set([...view.value.coverage.inventory.reasons, 'inventory-cap']),
                ),
              }
            : view.value.coverage;

        return projectDeclarationDetail({
          context: this.context,
          gen,
          freshness,
          detail,
          groupBy,
          limit,
          cursor: opts?.cursor,
          filter,
          inventory,
          totalMatches,
          coverage,
          binding: {
            projectKey: this.context.projectKey,
            generationKey: gen.key,
            queryDigest,
          },
        });
      },
    );
  }

  async referencesTo(
    declarationId: string,
    opts?: ReferencesToOptions,
  ): Promise<Result<GraphToolResult<ReferencesToDto>, McpReadError>> {
    const filter = this.context.resolveFilter(opts?.filter, 'discover');
    const limit = clampLimit(opts?.limit, DEFAULT_REFERENCE_LIMIT);
    const groupBy = opts?.groupBy ?? 'none';
    const detail: CompactQueryDetail = opts?.detail ?? 'summary';
    const detailOk = validateDetail(detail, groupBy);
    if (!detailOk.ok) return detailOk;

    const queryDigest = digestNormalizedQuery({
      op: 'referencesTo',
      declarationId,
      kinds: opts?.kinds ?? null,
      filter,
      groupBy,
      detail,
      referenceScope: CROSS_FILE_SCOPE,
    });

    return this.context.runQuery(
      'referencesTo',
      { identityMode: 'occurrence', sourceScope: filter.sourceScope },
      (gen, freshness) => {
        if (gen === undefined) {
          const cursor = rejectCursorWithoutGeneration(opts?.cursor, {
            projectKey: this.context.projectKey,
            queryDigest,
          });
          if (!cursor.ok) return cursor;
          return this.context.envelope(emptyReferencesDto(detail, declarationId), gen, freshness, {
            coverage: completeInventoryCoverage(),
            page: { limit },
            filter,
          });
        }

        const matcher = this.context.sourceRoleMatcherFor(gen);
        if (!matcher.ok) return matcher;

        const view = referencesToDeclaration(
          gen.catalog,
          {
            declarationId,
            filter,
            limit: MAX_INVENTORY,
            ...(opts?.kinds === undefined ? {} : { kinds: opts.kinds }),
          },
          matcher.value,
        );
        if (!view.ok) {
          return err(readError(INVALID_QUERY, view.error.message));
        }
        if (view.value.declarationMissing) {
          return err(
            readError(
              'not-found',
              `Declaration id not found in semantic inventory: ${declarationId}`,
            ),
          );
        }

        const inventory = [...view.value.references].sort(compareReferenceSites);

        return projectReferenceDetail({
          context: this.context,
          gen,
          freshness,
          detail,
          groupBy,
          limit,
          cursor: opts?.cursor,
          filter,
          declarationId,
          inventory,
          totalMatches: view.value.totalMatches,
          coverage: view.value.coverage,
          binding: {
            projectKey: this.context.projectKey,
            generationKey: gen.key,
            queryDigest,
          },
        });
      },
    );
  }
}

function emptyDeclarationDto(detail: CompactQueryDetail): DeclarationSearchDto {
  return { detail, referenceScope: CROSS_FILE_SCOPE, declarations: [], totalMatches: 0 };
}

function emptyReferencesDto(detail: CompactQueryDetail, declarationId: string): ReferencesToDto {
  return {
    detail,
    referenceScope: CROSS_FILE_SCOPE,
    declarationId,
    references: [],
    totalMatches: 0,
  };
}

function projectDeclarationDetail(input: {
  readonly context: SqliteGraphQueryContext;
  readonly gen: CatalogGeneration;
  readonly freshness: GraphToolResult<unknown>['freshness'];
  readonly detail: CompactQueryDetail;
  readonly groupBy: DeclarationGroupBy;
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly filter: GraphSourceFilter;
  readonly inventory: readonly DeclarationRef[];
  readonly totalMatches: number;
  readonly coverage: GraphReadFacetCoverage;
  readonly binding: {
    readonly projectKey: string;
    readonly generationKey: string;
    readonly queryDigest: string;
  };
}): Result<GraphToolResult<DeclarationSearchDto>, McpReadError> {
  const {
    context,
    gen,
    freshness,
    detail,
    groupBy,
    limit,
    cursor,
    filter,
    inventory,
    totalMatches,
    coverage,
    binding,
  } = input;
  const pageInput = {
    ...binding,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  };

  if (detail === 'summary') {
    return ok(
      context.envelope(
        {
          detail: 'summary',
          referenceScope: CROSS_FILE_SCOPE,
          declarations: [],
          totalMatches,
        },
        gen,
        freshness,
        {
          coverage: rollupFacets({
            inventory: coverage.inventory,
            evidence: UNREQUESTED_FACET,
            grouping: UNREQUESTED_FACET,
            projection: UNREQUESTED_FACET,
          }),
          page: { limit },
          filter,
        },
      ),
    );
  }

  if (detail === 'groups') {
    const grouped = groupRows(inventory, groupBy, (row, mode) =>
      mode === 'package' ? row.package : row.filePath,
    );
    const paged = pageRows(grouped.groups ?? [], pageInput, (group) => group.key);
    if (!paged.ok) return paged;
    return ok(
      context.envelope(
        {
          detail: 'groups',
          referenceScope: CROSS_FILE_SCOPE,
          declarations: [],
          totalMatches,
        },
        gen,
        freshness,
        {
          coverage: rollupFacets({
            inventory: coverage.inventory,
            evidence: UNREQUESTED_FACET,
            grouping: makeFacet(true, new Set(grouped.groupTruncated ? ['group-key-cap'] : [])),
            projection: makeFacet(true, new Set()),
          }),
          page: {
            limit,
            ...(paged.value.nextCursor === undefined ? {} : { nextCursor: paged.value.nextCursor }),
          },
          filter,
          ...(paged.value.rows.length === 0 ? {} : { groups: paged.value.rows }),
        },
      ),
    );
  }

  const paged = pageRows([...inventory], pageInput, (row) => declarationStableKey(row));
  if (!paged.ok) return paged;
  return ok(
    context.envelope(
      {
        detail: 'nodes',
        referenceScope: CROSS_FILE_SCOPE,
        declarations: paged.value.rows.map(toDeclarationDto),
        totalMatches,
      },
      gen,
      freshness,
      {
        coverage: rollupFacets({
          inventory: coverage.inventory,
          evidence: UNREQUESTED_FACET,
          grouping: UNREQUESTED_FACET,
          projection: makeFacet(true, new Set()),
        }),
        page: {
          limit,
          ...(paged.value.nextCursor === undefined ? {} : { nextCursor: paged.value.nextCursor }),
        },
        filter,
      },
    ),
  );
}

function projectReferenceDetail(input: {
  readonly context: SqliteGraphQueryContext;
  readonly gen: CatalogGeneration;
  readonly freshness: GraphToolResult<unknown>['freshness'];
  readonly detail: CompactQueryDetail;
  readonly groupBy: DeclarationGroupBy;
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly filter: GraphSourceFilter;
  readonly declarationId: string;
  readonly inventory: readonly ReferenceSiteRef[];
  readonly totalMatches: number;
  readonly coverage: GraphReadFacetCoverage;
  readonly binding: {
    readonly projectKey: string;
    readonly generationKey: string;
    readonly queryDigest: string;
  };
}): Result<GraphToolResult<ReferencesToDto>, McpReadError> {
  const {
    context,
    gen,
    freshness,
    detail,
    groupBy,
    limit,
    cursor,
    filter,
    declarationId,
    inventory,
    totalMatches,
    coverage,
    binding,
  } = input;
  const pageInput = {
    ...binding,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  };

  const kindCountsMap = new Map<string, number>();
  for (const ref of inventory) {
    kindCountsMap.set(ref.kind, (kindCountsMap.get(ref.kind) ?? 0) + 1);
  }
  const kindCounts = [...kindCountsMap.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => compareCodePointStrings(a.kind, b.kind));

  if (detail === 'summary') {
    return ok(
      context.envelope(
        {
          detail: 'summary',
          referenceScope: CROSS_FILE_SCOPE,
          declarationId,
          references: [],
          totalMatches,
          kindCounts,
        },
        gen,
        freshness,
        {
          coverage: rollupFacets({
            inventory: coverage.inventory,
            evidence: coverage.evidence,
            grouping: UNREQUESTED_FACET,
            projection: UNREQUESTED_FACET,
          }),
          page: { limit },
          filter,
        },
      ),
    );
  }

  if (detail === 'groups') {
    const grouped = groupRows(inventory, groupBy, (row, mode) =>
      mode === 'package' ? row.package : row.filePath,
    );
    const paged = pageRows(grouped.groups ?? [], pageInput, (group) => group.key);
    if (!paged.ok) return paged;
    return ok(
      context.envelope(
        {
          detail: 'groups',
          referenceScope: CROSS_FILE_SCOPE,
          declarationId,
          references: [],
          totalMatches,
          kindCounts,
        },
        gen,
        freshness,
        {
          coverage: rollupFacets({
            inventory: coverage.inventory,
            evidence: coverage.evidence,
            grouping: makeFacet(true, new Set(grouped.groupTruncated ? ['group-key-cap'] : [])),
            projection: makeFacet(true, new Set()),
          }),
          page: {
            limit,
            ...(paged.value.nextCursor === undefined ? {} : { nextCursor: paged.value.nextCursor }),
          },
          filter,
          ...(paged.value.rows.length === 0 ? {} : { groups: paged.value.rows }),
        },
      ),
    );
  }

  const paged = pageRows([...inventory], pageInput, (row) => referenceStableKey(row));
  if (!paged.ok) return paged;
  return ok(
    context.envelope(
      {
        detail: 'nodes',
        referenceScope: CROSS_FILE_SCOPE,
        declarationId,
        references: paged.value.rows.map(toReferenceDto),
        totalMatches,
        kindCounts,
      },
      gen,
      freshness,
      {
        coverage: rollupFacets({
          inventory: coverage.inventory,
          evidence: coverage.evidence,
          grouping: UNREQUESTED_FACET,
          projection: makeFacet(true, new Set()),
        }),
        page: {
          limit,
          ...(paged.value.nextCursor === undefined ? {} : { nextCursor: paged.value.nextCursor }),
        },
        filter,
      },
    ),
  );
}

// Silence unused import when SourceRoleMatcher is only used as type in comments.

export { type SourceRoleMatcher } from '@opensip-cli/graph/read';
