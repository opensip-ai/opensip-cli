/**
 * Public graph/read views for declaration facts and cross-file references
 * (P2 MCP audit Phase 3 Task 3.6).
 *
 * Callable-only {@link searchSymbolOccurrences} is unchanged. These views
 * project the optional semantic plane with independent coverage facets and
 * explicit present-empty vs absent (unsupported) semantics.
 */

import { err, ok, type Result } from '@opensip-cli/core';

import {
  codePointSortKey,
  compareCodePointStrings,
  matchesContinuationIdentity,
} from '../code-point-order.js';

import {
  insertBoundedTopK,
  makeFacet,
  rollupFacets,
  UNREQUESTED_FACET,
  type ReadGroupSummary,
  boundedIterableGroups,
} from './bounded-view.js';
import {
  type EffectiveGraphSourceFilter,
  type GraphReadFacetCoverage,
  type GraphSourceFilter,
} from './query-contracts.js';
import { matchesGraphSourceFilterWithRoles, type SourceRoleMatcher } from './source-filter.js';

import type { GraphReadError } from './types.js';
import type {
  Catalog,
  CrossFileReferenceFact,
  DeclarationFact,
  DeclarationKind,
  FunctionKind,
  ReferenceKind,
  SemanticFactBundle,
  Visibility,
} from '../types.js';

// Plan 01: the `GRAPH` head was mapped by nothing, so every one of these resolved to
// UNKNOWN_FAILURE — fatal and operator-only — for conditions MCP consumers branch on.

/** Match semantics for declaration search (mirrors symbol search). */
export type DeclarationSearchMatch = 'substring' | 'exact' | 'qualified';

/** Reference scope stamped on every declaration/reference view (declared once). */
const CROSS_FILE_SCOPE = 'cross-file' as const;

export interface DeclarationSearchQuery {
  readonly query: string;
  readonly match: DeclarationSearchMatch;
  readonly filter: GraphSourceFilter;
  readonly kinds?: readonly DeclarationKind[];
  readonly limit: number;
  readonly afterKey?: string;
  readonly groupBy?: 'none' | 'package' | 'file';
}

export interface DeclarationRef {
  readonly declarationId: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: DeclarationKind;
  readonly package: string;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly visibility: DeclarationFact['visibility'];
  readonly exportRole: DeclarationFact['exportRole'];
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
}

export interface DeclarationSearchView {
  readonly referenceScope: 'cross-file';
  readonly declarations: readonly DeclarationRef[];
  readonly hasMore: boolean;
  readonly totalMatches: number;
  readonly effectiveFilter: EffectiveGraphSourceFilter;
  readonly coverage: GraphReadFacetCoverage;
  readonly groups?: readonly ReadGroupSummary[];
  /** True when the catalog plane is absent (unsupported). */
  readonly unsupported: boolean;
}

export interface ReferencesToQuery {
  readonly declarationId: string;
  readonly filter: GraphSourceFilter;
  readonly kinds?: readonly ReferenceKind[];
  readonly limit: number;
  readonly afterKey?: string;
  readonly groupBy?: 'none' | 'package' | 'file';
}

export interface ReferenceSiteRef {
  readonly referenceId: string;
  readonly kind: ReferenceKind;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly package: string;
  readonly targetDeclarationId?: string;
  readonly targetPackage?: string;
  readonly targetName?: string;
  readonly targetKind?: DeclarationKind;
  readonly basis: CrossFileReferenceFact['basis'];
  readonly confidence: CrossFileReferenceFact['confidence'];
  readonly importSpecifier?: string;
  readonly reason?: string;
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
}

export interface ReferencesToView {
  readonly referenceScope: 'cross-file';
  readonly declarationId: string;
  readonly references: readonly ReferenceSiteRef[];
  readonly hasMore: boolean;
  readonly totalMatches: number;
  readonly effectiveFilter: EffectiveGraphSourceFilter;
  readonly coverage: GraphReadFacetCoverage;
  readonly groups?: readonly ReadGroupSummary[];
  readonly unsupported: boolean;
  /** True when the declaration id is not present in the retained inventory. */
  readonly declarationMissing: boolean;
}

function viewError(message: string): GraphReadError {
  return { code: 'query-invalid', operation: 'analysis', message };
}

function occurrenceLike(fact: {
  readonly filePath: string;
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
  readonly package: string;
}): {
  readonly filePath: string;
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
  readonly package: string;
  readonly kind: FunctionKind;
  readonly visibility: Visibility;
} {
  // Path / package / generated / test filters only. Kind and visibility on
  // GraphSourceFilter are FunctionOccurrence axes — declaration kinds are
  // filtered separately via DeclarationSearchQuery.kinds.
  return {
    filePath: fact.filePath,
    inTestFile: fact.inTestFile,
    definedInGenerated: fact.definedInGenerated,
    package: fact.package,
    kind: 'function-declaration',
    visibility: 'exported',
  };
}

/** Drop FunctionOccurrence-only axes so they cannot false-filter declarations. */
function sourceOnlyFilter(filter: GraphSourceFilter): GraphSourceFilter {
  return {
    sourceScope: filter.sourceScope,
    generated: filter.generated,
    ...(filter.packages === undefined ? {} : { packages: filter.packages }),
    ...(filter.filePath === undefined ? {} : { filePath: filter.filePath }),
    ...(filter.filePrefix === undefined ? {} : { filePrefix: filter.filePrefix }),
    ...(filter.sourceRoles === undefined ? {} : { sourceRoles: filter.sourceRoles }),
  };
}

export function declarationStableKey(ref: DeclarationRef): string {
  return [
    codePointSortKey(ref.package),
    codePointSortKey(ref.filePath),
    String(ref.line).padStart(16, '0'),
    String(ref.column).padStart(16, '0'),
    codePointSortKey(ref.declarationId),
  ].join('|');
}

export function referenceStableKey(ref: ReferenceSiteRef): string {
  return [
    codePointSortKey(ref.filePath),
    String(ref.line).padStart(16, '0'),
    String(ref.column).padStart(16, '0'),
    codePointSortKey(ref.kind),
    codePointSortKey(ref.referenceId),
  ].join('|');
}

export function compareDeclarationRefs(a: DeclarationRef, b: DeclarationRef): number {
  return (
    compareCodePointStrings(a.package, b.package) ||
    compareCodePointStrings(a.filePath, b.filePath) ||
    a.line - b.line ||
    a.column - b.column ||
    compareCodePointStrings(a.declarationId, b.declarationId)
  );
}

export function compareReferenceSites(a: ReferenceSiteRef, b: ReferenceSiteRef): number {
  return (
    compareCodePointStrings(a.filePath, b.filePath) ||
    a.line - b.line ||
    a.column - b.column ||
    compareCodePointStrings(a.kind, b.kind) ||
    compareCodePointStrings(a.referenceId, b.referenceId)
  );
}

function toDeclarationRef(d: DeclarationFact): DeclarationRef | undefined {
  // Hostile oversized fields already rejected at persist; omit if empty.
  if (d.name.length === 0 || d.declarationId.length === 0) return undefined;
  return {
    declarationId: d.declarationId,
    name: d.name,
    qualifiedName: d.qualifiedName,
    kind: d.kind,
    package: d.package,
    filePath: d.filePath,
    line: d.line,
    column: d.column,
    endLine: d.endLine,
    endColumn: d.endColumn,
    visibility: d.visibility,
    exportRole: d.exportRole,
    inTestFile: d.inTestFile,
    definedInGenerated: d.definedInGenerated,
  };
}

function toReferenceSite(r: CrossFileReferenceFact): ReferenceSiteRef {
  return {
    referenceId: r.referenceId,
    kind: r.kind,
    filePath: r.filePath,
    line: r.line,
    column: r.column,
    endLine: r.endLine,
    endColumn: r.endColumn,
    package: r.package,
    ...(r.targetDeclarationId === undefined ? {} : { targetDeclarationId: r.targetDeclarationId }),
    ...(r.targetPackage === undefined ? {} : { targetPackage: r.targetPackage }),
    ...(r.targetName === undefined ? {} : { targetName: r.targetName }),
    ...(r.targetKind === undefined ? {} : { targetKind: r.targetKind }),
    basis: r.basis,
    confidence: r.confidence,
    ...(r.importSpecifier === undefined ? {} : { importSpecifier: r.importSpecifier }),
    ...(r.reason === undefined ? {} : { reason: r.reason }),
    inTestFile: r.inTestFile,
    definedInGenerated: r.definedInGenerated,
  };
}

function matchesDeclQuery(
  d: DeclarationFact,
  query: string,
  match: DeclarationSearchMatch,
): boolean {
  switch (match) {
    case 'substring': {
      return d.name.toLowerCase().includes(query.toLowerCase());
    }
    case 'exact': {
      return d.name === query;
    }
    case 'qualified': {
      return d.qualifiedName === query;
    }
    default: {
      const _e: never = match;
      return _e;
    }
  }
}

function planeInventoryFacet(
  catalog: Catalog,
  bundle: SemanticFactBundle | undefined,
): ReturnType<typeof makeFacet> {
  if (bundle === undefined) {
    const reasons = new Set<string>(['semantic-facts-unsupported']);
    if (catalog.resolutionMode === 'fast') reasons.add('resolution-mode-fast');
    // Inventory was requested; incomplete because the plane is unsupported.
    return makeFacet(true, reasons);
  }
  const reasons = new Set<string>(bundle.coverage.reasons);
  if (bundle.coverage.status === 'partial' && reasons.size === 0) {
    reasons.add('producer-partial');
  }
  return makeFacet(true, reasons);
}

/** Filter + sort declaration facts into the deterministic match list. */
function collectDeclarationMatches(
  bundle: SemanticFactBundle,
  query: DeclarationSearchQuery,
  matcher: SourceRoleMatcher,
): DeclarationRef[] {
  const kinds = query.kinds === undefined ? undefined : new Set(query.kinds);
  const filter = sourceOnlyFilter(query.filter);
  const matches: DeclarationRef[] = [];
  for (const d of bundle.declarations) {
    if (kinds !== undefined && !kinds.has(d.kind)) continue;
    if (!matchesGraphSourceFilterWithRoles(occurrenceLike(d), filter, matcher)) continue;
    if (!matchesDeclQuery(d, query.query, query.match)) continue;
    const ref = toDeclarationRef(d);
    if (ref === undefined) continue;
    matches.push(ref);
  }
  matches.sort(compareDeclarationRefs);
  return matches;
}

/** Filter + sort cross-file references targeting one declaration id. */
function collectReferenceMatches(
  bundle: SemanticFactBundle,
  query: ReferencesToQuery,
  matcher: SourceRoleMatcher,
): ReferenceSiteRef[] {
  const kinds = query.kinds === undefined ? undefined : new Set(query.kinds);
  const filter = sourceOnlyFilter(query.filter);
  const matches: ReferenceSiteRef[] = [];
  for (const r of bundle.references) {
    if (r.targetDeclarationId !== query.declarationId) continue;
    if (kinds !== undefined && !kinds.has(r.kind)) continue;
    if (!matchesGraphSourceFilterWithRoles(occurrenceLike(r), filter, matcher)) continue;
    matches.push(toReferenceSite(r));
  }
  matches.sort(compareReferenceSites);
  return matches;
}

/**
 * Apply the after-cursor skip and bounded top-K window, returning the page rows
 * plus whether more matches exist beyond the limit.
 */
function sliceWindow<T>(
  matches: readonly T[],
  afterStable: string | undefined,
  limit: number,
  stableKey: (item: T) => string,
  compare: (a: T, b: T) => number,
): { readonly rows: T[]; readonly hasMore: boolean } {
  const window: T[] = [];
  for (const item of matches) {
    if (afterStable !== undefined && compareCodePointStrings(stableKey(item), afterStable) <= 0) {
      continue;
    }
    insertBoundedTopK(window, item, limit + 1, compare);
  }
  const hasMore = window.length > limit;
  return { rows: hasMore ? window.slice(0, limit) : window, hasMore };
}

/** Build optional package/file groups and their truncation reasons. */
function buildGroups<T>(
  groupBy: NonNullable<DeclarationSearchQuery['groupBy']>,
  matches: readonly T[],
  pkgOf: (item: T) => string,
  fileOf: (item: T) => string,
): { readonly groups?: readonly ReadGroupSummary[]; readonly reasons: Set<string> } {
  if (groupBy === 'none') return { reasons: new Set<string>() };
  const grouped = boundedIterableGroups(
    () => matches,
    (item) => (groupBy === 'package' ? pkgOf(item) : fileOf(item)),
  );
  const reasons = new Set<string>();
  if (grouped.truncated === true) reasons.add('group-key-cap');
  return { groups: grouped.groups, reasons };
}

/**
 * Search declaration facts with filter-first semantics and a bounded top-K
 * window. Absent plane → empty declarations + incomplete inventory facet.
 */
export function searchDeclarationFacts(
  catalog: Catalog,
  query: DeclarationSearchQuery,
  matcher: SourceRoleMatcher,
): Result<DeclarationSearchView, GraphReadError> {
  try {
    const limit = Math.max(1, Math.min(500, Math.trunc(query.limit)));
    const bundle = catalog.semanticFacts;
    const inventory = planeInventoryFacet(catalog, bundle);

    if (bundle === undefined) {
      return ok({
        referenceScope: CROSS_FILE_SCOPE,
        declarations: [],
        hasMore: false,
        totalMatches: 0,
        effectiveFilter: query.filter,
        unsupported: true,
        coverage: rollupFacets({
          inventory,
          evidence: UNREQUESTED_FACET,
          grouping: UNREQUESTED_FACET,
          projection: UNREQUESTED_FACET,
        }),
      });
    }

    const matches = collectDeclarationMatches(bundle, query, matcher);
    const totalMatches = matches.length;

    let afterStable: string | undefined;
    const afterKey = query.afterKey;
    if (afterKey !== undefined) {
      const found = matches.find((m) =>
        matchesContinuationIdentity(declarationStableKey(m), afterKey),
      );
      if (found === undefined) {
        return err({
          code: 'cursor-invalid',
          operation: 'analysis',
          message: 'Cursor continuation anchor is not present in this catalog view',
        });
      }
      afterStable = declarationStableKey(found);
    }

    const { rows: declarations, hasMore } = sliceWindow(
      matches,
      afterStable,
      limit,
      declarationStableKey,
      compareDeclarationRefs,
    );

    const groupBy = query.groupBy ?? 'none';
    const grouping = buildGroups(
      groupBy,
      matches,
      (ref) => ref.package,
      (ref) => ref.filePath,
    );

    return ok({
      referenceScope: CROSS_FILE_SCOPE,
      declarations,
      hasMore,
      totalMatches,
      effectiveFilter: query.filter,
      unsupported: false,
      ...(grouping.groups === undefined ? {} : { groups: grouping.groups }),
      coverage: rollupFacets({
        inventory,
        evidence: UNREQUESTED_FACET,
        grouping:
          groupBy === 'none'
            ? UNREQUESTED_FACET
            : makeFacet(grouping.reasons.size === 0, grouping.reasons),
        projection: makeFacet(true, new Set()),
      }),
    });
  } catch {
    return err(viewError('Failed to search declaration facts'));
  }
}

/**
 * Cross-file references to a declaration id. Missing id is reported via
 * `declarationMissing` (caller maps to a typed MCP read error).
 */
export function referencesToDeclaration(
  catalog: Catalog,
  query: ReferencesToQuery,
  matcher: SourceRoleMatcher,
): Result<ReferencesToView, GraphReadError> {
  try {
    const limit = Math.max(1, Math.min(500, Math.trunc(query.limit)));
    const bundle = catalog.semanticFacts;
    const inventory = planeInventoryFacet(catalog, bundle);

    if (bundle === undefined) {
      return ok({
        referenceScope: CROSS_FILE_SCOPE,
        declarationId: query.declarationId,
        references: [],
        hasMore: false,
        totalMatches: 0,
        effectiveFilter: query.filter,
        unsupported: true,
        declarationMissing: false,
        coverage: rollupFacets({
          inventory,
          evidence: UNREQUESTED_FACET,
          grouping: UNREQUESTED_FACET,
          projection: UNREQUESTED_FACET,
        }),
      });
    }

    const declExists = bundle.declarations.some((d) => d.declarationId === query.declarationId);
    if (!declExists) {
      return ok({
        referenceScope: CROSS_FILE_SCOPE,
        declarationId: query.declarationId,
        references: [],
        hasMore: false,
        totalMatches: 0,
        effectiveFilter: query.filter,
        unsupported: false,
        declarationMissing: true,
        coverage: rollupFacets({
          inventory,
          evidence: UNREQUESTED_FACET,
          grouping: UNREQUESTED_FACET,
          projection: UNREQUESTED_FACET,
        }),
      });
    }

    const matches = collectReferenceMatches(bundle, query, matcher);
    const totalMatches = matches.length;

    let afterStable: string | undefined;
    const afterKey = query.afterKey;
    if (afterKey !== undefined) {
      const found = matches.find((m) =>
        matchesContinuationIdentity(referenceStableKey(m), afterKey),
      );
      if (found === undefined) {
        return err({
          code: 'cursor-invalid',
          operation: 'analysis',
          message: 'Cursor continuation anchor is not present in this catalog view',
        });
      }
      afterStable = referenceStableKey(found);
    }

    const { rows: references, hasMore } = sliceWindow(
      matches,
      afterStable,
      limit,
      referenceStableKey,
      compareReferenceSites,
    );

    const groupBy = query.groupBy ?? 'none';
    const grouping = buildGroups(
      groupBy,
      matches,
      (ref) => ref.package,
      (ref) => ref.filePath,
    );

    // Evidence facet: the concrete reference sites (cross-file only).
    const evidenceReasons = new Set<string>();
    if (bundle.coverage.status === 'partial') {
      for (const r of bundle.coverage.reasons) evidenceReasons.add(r);
    }

    return ok({
      referenceScope: CROSS_FILE_SCOPE,
      declarationId: query.declarationId,
      references,
      hasMore,
      totalMatches,
      effectiveFilter: query.filter,
      unsupported: false,
      declarationMissing: false,
      ...(grouping.groups === undefined ? {} : { groups: grouping.groups }),
      coverage: rollupFacets({
        inventory,
        evidence: makeFacet(evidenceReasons.size === 0, evidenceReasons),
        grouping:
          groupBy === 'none'
            ? UNREQUESTED_FACET
            : makeFacet(grouping.reasons.size === 0, grouping.reasons),
        projection: makeFacet(true, new Set()),
      }),
    });
  } catch {
    return err(viewError('Failed to load references to declaration'));
  }
}
