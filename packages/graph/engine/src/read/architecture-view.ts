/** Labelled, filtered, bounded architecture orientation metrics. */

import { err, ok, type Result } from '@opensip-cli/core';

import {
  codePointSortKey,
  compareCodePointStrings,
  matchesContinuationIdentity,
} from '../code-point-order.js';
import { buildFeatures } from '../pipeline/features.js';
import { occurrenceCallGraphFor } from '../pipeline/occurrence-call-graph.js';

import { boundedGroups, insertBoundedTopK, type ReadGroupSummary } from './bounded-view.js';
import {
  toGraphPackageName,
  toGraphSymbolRef,
  type EffectiveGraphSourceFilter,
  type GeneratedPolicy,
  type GraphReadCoverage,
  type GraphSourceFilter,
  type GraphSymbolRef,
  type SourceScope,
} from './query-contracts.js';
import { failGraphRead } from './read-boundary-failure.js';
import {
  isCanonicalProductionFilter,
  matchesGraphSourceFilterWithRoles,
  type SourceRoleMatcher,
} from './source-filter.js';

import type { GraphReadError } from './types.js';
import type { Catalog, FeatureTable, Indexes } from '../types.js';

/** Selectable architecture response families (P2 Phase 2.5). */
export type ArchitectureSection = 'metrics' | 'packageEdges' | 'hotspots';

/** Count-unit label for resolved-target distribution metrics (declared once). */
const RESOLVED_TARGETS_UNIT = 'resolved-targets' as const;

export interface ArchitectureViewQuery {
  readonly filter: GraphSourceFilter;
  readonly limit: number;
  readonly afterPackageEdgeKey?: string;
  readonly afterHotspotKey?: string;
  readonly packageEdgesDone?: boolean;
  readonly hotspotsDone?: boolean;
  readonly groupBy?: 'none' | 'package' | 'file';
  /**
   * Which row families to compute (P2 Phase 2.5). Default metrics-only.
   * Unselected families are not computed and are omitted from the response.
   */
  readonly sections?: readonly ArchitectureSection[];
  /**
   * Global top-N for each selected ranked family before page `limit` slices
   * inside that window. Default 20, max 100.
   */
  readonly topN?: number;
}

export interface ArchitectureFamilySummary {
  readonly totalAvailable: number;
  readonly selectedCount: number;
  readonly pageReturned: number;
}

export interface LabelledNodeCount {
  readonly value: number;
  readonly nodeIdentity: 'occurrence' | 'body-hash';
  readonly sourceScope: SourceScope;
  readonly generated: GeneratedPolicy;
}

export interface LabelledPackageCount {
  readonly value: number;
  readonly nodeIdentity: 'package';
  readonly sourceScope: SourceScope;
  readonly generated: GeneratedPolicy;
}

export interface LabelledDistribution {
  readonly values: Readonly<Record<string, number>>;
  readonly countUnit: 'resolved-targets' | 'unresolved-call-sites';
}

export interface CallEvidenceMetrics {
  readonly resolvedCallSites: number;
  readonly resolvedTargets: number;
  readonly unresolvedCallSites: number;
  /** Aggregate compatibility views; `distributionCountUnit` makes the mixed unit explicit. */
  readonly confidence: Readonly<Record<string, number>>;
  readonly resolution: Readonly<Record<string, number>>;
  readonly distributionCountUnit: 'resolved-targets-plus-unresolved-call-sites';
  readonly resolvedTargetConfidence: LabelledDistribution;
  readonly resolvedTargetResolution: LabelledDistribution;
  readonly unresolvedCallSiteConfidence: LabelledDistribution;
  readonly unresolvedCallSiteResolution: LabelledDistribution;
  readonly nodeIdentity: 'occurrence';
  readonly sourceScope: SourceScope;
  readonly generated: GeneratedPolicy;
  readonly edgeKind: 'call';
  readonly catalogResolutionMode: 'exact' | 'fast';
}

export interface ArchitecturePackageEdgeRow {
  readonly fromPackage: string;
  readonly toPackage: string;
  readonly kind: 'call';
  readonly count: number;
  readonly countUnit: 'resolved-targets';
  readonly nodeIdentity: 'package';
  readonly sourceScope: SourceScope;
  readonly generated: GeneratedPolicy;
  readonly catalogResolutionMode: 'exact' | 'fast';
}

export interface ArchitectureHotspot {
  readonly symbol: GraphSymbolRef;
  readonly direct: number;
  readonly transitive: number;
  readonly score: number;
  readonly identityMode: 'body-twin-union';
  readonly twinCount: number;
  readonly matchingTwinCount: number;
  readonly sourceScope: SourceScope;
  readonly generated: GeneratedPolicy;
  readonly edgeKind: 'call';
  readonly catalogResolutionMode: 'exact' | 'fast';
}

export interface ArchitectureView {
  readonly languages: readonly string[];
  readonly occurrenceCount: LabelledNodeCount;
  readonly uniqueBodyCount: LabelledNodeCount;
  readonly callEvidence: CallEvidenceMetrics;
  readonly packageCount: LabelledPackageCount;
  readonly includedSections: readonly ArchitectureSection[];
  readonly packageEdges?: readonly ArchitecturePackageEdgeRow[];
  readonly packageEdgesHasMore: boolean;
  readonly packageEdgesSummary?: ArchitectureFamilySummary;
  readonly hotspots?: readonly ArchitectureHotspot[];
  readonly hotspotsHasMore: boolean;
  readonly hotspotsSummary?: ArchitectureFamilySummary;
  readonly effectiveFilter: EffectiveGraphSourceFilter;
  readonly coverage: GraphReadCoverage;
  readonly groups?: readonly ReadGroupSummary[];
}

const DEFAULT_TOP_N = 20;
const MAX_TOP_N = 100;
const DEFAULT_SECTIONS: readonly ArchitectureSection[] = ['metrics'];

function normalizeSections(
  sections: readonly ArchitectureSection[] | undefined,
): readonly ArchitectureSection[] {
  if (sections === undefined || sections.length === 0) return DEFAULT_SECTIONS;
  const unique: ArchitectureSection[] = [];
  for (const section of sections) {
    if (!unique.includes(section)) unique.push(section);
  }
  return unique;
}

function resolveTopN(topN: number | undefined): number {
  if (topN === undefined || !Number.isFinite(topN)) return DEFAULT_TOP_N;
  return Math.min(MAX_TOP_N, Math.max(1, Math.trunc(topN)));
}

function wantsSection(
  sections: readonly ArchitectureSection[],
  section: ArchitectureSection,
): boolean {
  return sections.includes(section);
}

interface ArchitectureCounts {
  readonly occurrenceCount: number;
  readonly bodyHashes: ReadonlySet<string>;
  readonly packageNames: ReadonlySet<string>;
}

const MAX_ORIENTATION_ROWS = 10_000;
const DESCENDING_KEY_CEILING = Number.MAX_SAFE_INTEGER;
const MALFORMED_SYMBOL_REASON = 'malformed-symbol-omitted';
const MALFORMED_CALL_REASON = 'malformed-call-edge-omitted';

function resolutionMode(catalog: Catalog): 'exact' | 'fast' {
  return catalog.resolutionMode ?? 'exact';
}

function descendingIntegerKey(value: number): string {
  const normalized = Math.max(0, Math.min(DESCENDING_KEY_CEILING, Math.trunc(value)));
  return String(DESCENDING_KEY_CEILING - normalized).padStart(16, '0');
}

export function packageEdgeStableKey(row: ArchitecturePackageEdgeRow): string {
  return [
    descendingIntegerKey(row.count),
    codePointSortKey(row.fromPackage),
    codePointSortKey(row.toPackage),
  ].join('|');
}

export function hotspotStableKey(row: ArchitectureHotspot): string {
  return [descendingIntegerKey(row.score * 2), codePointSortKey(row.symbol.symbolId)].join('|');
}

function comparePackageEdges(a: ArchitecturePackageEdgeRow, b: ArchitecturePackageEdgeRow) {
  return compareCodePointStrings(packageEdgeStableKey(a), packageEdgeStableKey(b));
}

function compareHotspots(a: ArchitectureHotspot, b: ArchitectureHotspot) {
  return compareCodePointStrings(hotspotStableKey(a), hotspotStableKey(b));
}

/** Internal deterministic top-K helper, exported only for direct regression tests. */
export function boundedArchitectureRows<T>(
  rows: Iterable<T>,
  cap: number,
  compare: (left: T, right: T) => number,
): { readonly rows: readonly T[]; readonly truncated: boolean } {
  const selected: T[] = [];
  let total = 0;
  for (const row of rows) {
    total++;
    insertBoundedTopK(selected, row, cap, compare);
  }
  return { rows: selected, truncated: total > cap };
}

function countArchitectureNodes(
  indexes: Indexes,
  filter: GraphSourceFilter,
  reasons: Set<string>,
  matcher: SourceRoleMatcher,
): ArchitectureCounts {
  const bodyHashes = new Set<string>();
  const packageNames = new Set<string>();
  let occurrenceCount = 0;
  for (const occurrence of indexes.byOccId.values()) {
    if (
      occurrence.kind === 'module-init' ||
      !matchesGraphSourceFilterWithRoles(occurrence, filter, matcher)
    )
      continue;
    const symbol = toGraphSymbolRef(occurrence);
    if (symbol === undefined) {
      reasons.add(MALFORMED_SYMBOL_REASON);
      continue;
    }
    occurrenceCount++;
    bodyHashes.add(symbol.bodyHash);
    packageNames.add(symbol.package);
  }
  return { occurrenceCount, bodyHashes, packageNames };
}

/**
 * Own-key-only counter increment (P2 Phase 1.2). A `Map` treats every label —
 * including hostile ones from a malformed catalog (`__proto__`, `constructor`,
 * `toString`, `prototype`) — as pure data: no prototype walk (so a label never
 * reads an inherited function and string-concats) and no `__proto__` setter.
 */
function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Fold `source` counts into `target` with the SAME safe own-key semantics. */
function mergeCounts(target: Map<string, number>, source: ReadonlyMap<string, number>): void {
  for (const [key, value] of source) target.set(key, (target.get(key) ?? 0) + value);
}

/**
 * Materialize a counter `Map` as a deterministically ordered plain output record
 * at the DTO boundary. `Object.fromEntries` uses CreateDataProperty, so a
 * `__proto__` label becomes an OWN enumerable data property — never a prototype
 * mutation — and the serialized DTO stays a plain JSON object.
 */
function toCountRecord(counts: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => compareCodePointStrings(a[0], b[0])),
  );
}

function noteMalformedCalls(malformedCalls: number, reasons: Set<string>): void {
  if (malformedCalls > 0) reasons.add(MALFORMED_CALL_REASON);
}

function buildCallMetrics(
  catalog: Catalog,
  indexes: Indexes,
  filter: GraphSourceFilter,
  reasons: Set<string>,
  matcher: SourceRoleMatcher,
): CallEvidenceMetrics {
  const graph = occurrenceCallGraphFor(indexes);
  noteMalformedCalls(graph.malformedCalls, reasons);
  const resolvedConfidence = new Map<string, number>();
  const resolvedResolution = new Map<string, number>();
  const unresolvedConfidence = new Map<string, number>();
  const unresolvedResolution = new Map<string, number>();
  const resolvedSiteKeys = new Set<string>();
  const unresolvedSites = new Map<
    string,
    { readonly confidence: string; readonly resolution: string }
  >();
  let resolvedTargets = 0;

  for (const edge of graph.edges) {
    if (
      !matchesGraphSourceFilterWithRoles(edge.owner, filter, matcher) ||
      !matchesGraphSourceFilterWithRoles(edge.target, filter, matcher)
    ) {
      continue;
    }
    const owner = toGraphSymbolRef(edge.owner);
    const target = toGraphSymbolRef(edge.target);
    if (owner === undefined || target === undefined) {
      reasons.add(MALFORMED_SYMBOL_REASON);
      continue;
    }
    resolvedSiteKeys.add(
      `${owner.symbolId}\0${String(edge.callSite.line)}\0${String(edge.callSite.column)}`,
    );
    resolvedTargets++;
    increment(resolvedConfidence, edge.confidence);
    increment(resolvedResolution, edge.resolution);
  }
  for (const unresolved of graph.unresolved) {
    if (!matchesGraphSourceFilterWithRoles(unresolved.owner, filter, matcher)) continue;
    const owner = toGraphSymbolRef(unresolved.owner);
    if (owner === undefined) {
      reasons.add(MALFORMED_SYMBOL_REASON);
      continue;
    }
    const siteKey = `${owner.symbolId}\0${String(unresolved.callSite.line)}\0${String(
      unresolved.callSite.column,
    )}`;
    const candidate = {
      confidence: unresolved.confidence,
      resolution: unresolved.resolution,
    };
    const prior = unresolvedSites.get(siteKey);
    if (
      prior === undefined ||
      compareCodePointStrings(
        `${candidate.confidence}|${candidate.resolution}`,
        `${prior.confidence}|${prior.resolution}`,
      ) < 0
    ) {
      unresolvedSites.set(siteKey, candidate);
    }
  }
  for (const unresolved of unresolvedSites.values()) {
    increment(unresolvedConfidence, unresolved.confidence);
    increment(unresolvedResolution, unresolved.resolution);
  }

  // Combined distributions = resolved + unresolved, folded through the ONE safe
  // merge helper (no duplicated inline key handling for the two label kinds).
  const confidence = new Map(resolvedConfidence);
  mergeCounts(confidence, unresolvedConfidence);
  const resolution = new Map(resolvedResolution);
  mergeCounts(resolution, unresolvedResolution);

  return {
    resolvedCallSites: resolvedSiteKeys.size,
    resolvedTargets,
    unresolvedCallSites: unresolvedSites.size,
    confidence: toCountRecord(confidence),
    resolution: toCountRecord(resolution),
    distributionCountUnit: 'resolved-targets-plus-unresolved-call-sites',
    resolvedTargetConfidence: {
      values: toCountRecord(resolvedConfidence),
      countUnit: RESOLVED_TARGETS_UNIT,
    },
    resolvedTargetResolution: {
      values: toCountRecord(resolvedResolution),
      countUnit: RESOLVED_TARGETS_UNIT,
    },
    unresolvedCallSiteConfidence: {
      values: toCountRecord(unresolvedConfidence),
      countUnit: 'unresolved-call-sites',
    },
    unresolvedCallSiteResolution: {
      values: toCountRecord(unresolvedResolution),
      countUnit: 'unresolved-call-sites',
    },
    nodeIdentity: 'occurrence',
    sourceScope: filter.sourceScope,
    generated: filter.generated,
    edgeKind: 'call',
    catalogResolutionMode: resolutionMode(catalog),
  };
}

function packageEdgeRow(
  catalog: Catalog,
  filter: GraphSourceFilter,
  fromPackage: string,
  toPackage: string,
  count: number,
): ArchitecturePackageEdgeRow {
  return {
    fromPackage,
    toPackage,
    kind: 'call',
    count,
    countUnit: RESOLVED_TARGETS_UNIT,
    nodeIdentity: 'package',
    sourceScope: filter.sourceScope,
    generated: filter.generated,
    catalogResolutionMode: resolutionMode(catalog),
  };
}

function canonicalPackageEdges(
  catalog: Catalog,
  indexes: Indexes,
  filter: GraphSourceFilter,
  reasons: Set<string>,
  cachedFeatures: FeatureTable | undefined,
): ArchitecturePackageEdgeRow[] {
  const features = cachedFeatures ?? buildFeatures(catalog, indexes, {}, ['packageCoupling']);
  const rows: ArchitecturePackageEdgeRow[] = [];
  for (const edge of features.edge) {
    const from = toGraphPackageName(edge.callerPackage);
    const to = toGraphPackageName(edge.calleePackage);
    if (from === undefined || to === undefined) {
      reasons.add('malformed-package-omitted');
      continue;
    }
    rows.push(packageEdgeRow(catalog, filter, from, to, edge.count));
  }
  return rows;
}

function filteredPackageEdges(
  catalog: Catalog,
  indexes: Indexes,
  filter: GraphSourceFilter,
  reasons: Set<string>,
  matcher: SourceRoleMatcher,
): ArchitecturePackageEdgeRow[] {
  const buckets = new Map<string, ArchitecturePackageEdgeRow>();
  const graph = occurrenceCallGraphFor(indexes);
  noteMalformedCalls(graph.malformedCalls, reasons);
  for (const edge of graph.edges) {
    if (
      !matchesGraphSourceFilterWithRoles(edge.owner, filter, matcher) ||
      !matchesGraphSourceFilterWithRoles(edge.target, filter, matcher)
    ) {
      continue;
    }
    const owner = toGraphSymbolRef(edge.owner);
    const target = toGraphSymbolRef(edge.target);
    if (owner === undefined || target === undefined) {
      reasons.add(MALFORMED_SYMBOL_REASON);
      continue;
    }
    const from = owner.package;
    const to = target.package;
    const key = `${from}\0${to}`;
    const current = buckets.get(key);
    if (current !== undefined) {
      buckets.set(key, { ...current, count: current.count + 1 });
      continue;
    }
    buckets.set(key, packageEdgeRow(catalog, filter, from, to, 1));
  }
  return [...buckets.values()];
}

/** Shared catalog/filter/reasons bag for architecture family builders. */
interface ArchitectureFamilyInput {
  readonly catalog: Catalog;
  readonly indexes: Indexes;
  readonly filter: GraphSourceFilter;
  readonly reasons: Set<string>;
  readonly cachedFeatures: FeatureTable | undefined;
  readonly matcher: SourceRoleMatcher;
}

function buildPackageEdges(input: ArchitectureFamilyInput): ArchitecturePackageEdgeRow[] {
  const { catalog, indexes, filter, reasons, cachedFeatures, matcher } = input;
  const rows = isCanonicalProductionFilter(filter)
    ? canonicalPackageEdges(catalog, indexes, filter, reasons, cachedFeatures)
    : filteredPackageEdges(catalog, indexes, filter, reasons, matcher);
  const selected = boundedArchitectureRows(rows, MAX_ORIENTATION_ROWS, comparePackageEdges);
  if (selected.truncated) reasons.add('package-edge-cap');
  return [...selected.rows];
}

function buildHotspots(input: ArchitectureFamilyInput): ArchitectureHotspot[] {
  const { catalog, indexes, filter, reasons, cachedFeatures, matcher } = input;
  const features = cachedFeatures ?? buildFeatures(catalog, indexes, {}, ['blast']);
  const allTwinCounts = new Map<string, number>();
  const matchingTwinCounts = new Map<string, number>();
  const representatives = new Map<string, GraphSymbolRef>();
  for (const occurrence of indexes.byOccId.values()) {
    if (occurrence.kind === 'module-init') continue;
    const symbol = toGraphSymbolRef(occurrence);
    if (symbol === undefined) {
      reasons.add(MALFORMED_SYMBOL_REASON);
      continue;
    }
    allTwinCounts.set(symbol.bodyHash, (allTwinCounts.get(symbol.bodyHash) ?? 0) + 1);
    if (matchesGraphSourceFilterWithRoles(symbol, filter, matcher)) {
      matchingTwinCounts.set(symbol.bodyHash, (matchingTwinCounts.get(symbol.bodyHash) ?? 0) + 1);
      const prior = representatives.get(symbol.bodyHash);
      if (prior === undefined || compareCodePointStrings(symbol.symbolId, prior.symbolId) < 0) {
        representatives.set(symbol.bodyHash, symbol);
      }
    }
  }

  const rows: ArchitectureHotspot[] = [];
  let candidateCount = 0;
  for (const [bodyHash, symbol] of representatives) {
    const blast = features.function.get(bodyHash)?.blast;
    if (blast === undefined) continue;
    candidateCount++;
    insertBoundedTopK(
      rows,
      {
        symbol,
        direct: blast.direct,
        transitive: blast.transitive,
        score: blast.score,
        identityMode: 'body-twin-union',
        twinCount: allTwinCounts.get(bodyHash) ?? 1,
        matchingTwinCount: matchingTwinCounts.get(bodyHash) ?? 1,
        sourceScope: filter.sourceScope,
        generated: filter.generated,
        edgeKind: 'call',
        catalogResolutionMode: resolutionMode(catalog),
      },
      MAX_ORIENTATION_ROWS,
      compareHotspots,
    );
  }
  if (candidateCount > MAX_ORIENTATION_ROWS) reasons.add('hotspot-cap');
  return rows;
}

function pageSorted<T>(
  rows: readonly T[],
  limit: number,
  afterKey: string | undefined,
  done: boolean,
  keyOf: (row: T) => string,
): { rows: readonly T[]; hasMore: boolean } {
  if (done) return { rows: [], hasMore: false };
  const window: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (afterKey !== undefined && compareCodePointStrings(key, afterKey) <= 0) continue;
    insertBoundedTopK(window, row, limit + 1, (a, b) =>
      compareCodePointStrings(keyOf(a), keyOf(b)),
    );
  }
  const hasMore = window.length > limit;
  return { rows: hasMore ? window.slice(0, limit) : window, hasMore };
}

function resolveStableAnchor<T>(
  rows: readonly T[],
  continuationIdentity: string | undefined,
  done: boolean,
  keyOf: (row: T) => string,
): string | null | undefined {
  if (continuationIdentity === undefined || done) return undefined;
  for (const row of rows) {
    const stableKey = keyOf(row);
    if (matchesContinuationIdentity(stableKey, continuationIdentity)) return stableKey;
  }
  return null;
}

function architectureGroups(
  packageEdges: readonly ArchitecturePackageEdgeRow[],
  hotspots: readonly ArchitectureHotspot[],
  groupBy: 'none' | 'package' | 'file',
) {
  if (groupBy === 'none') return;
  if (groupBy === 'file') {
    return boundedGroups(hotspots, (row) => row.symbol.filePath);
  }
  return boundedGroups(
    [
      ...packageEdges.map((row) => ({ package: row.fromPackage })),
      ...hotspots.map((row) => ({ package: row.symbol.package })),
    ],
    (row) => row.package,
  );
}

interface RankedPage<T> {
  readonly rows: readonly T[];
  readonly hasMore: boolean;
  readonly cursorInvalid: boolean;
}

interface RankedFamilyPageInput<T> {
  readonly selected: boolean;
  readonly window: readonly T[];
  readonly limit: number;
  readonly afterKey: string | undefined;
  readonly done: boolean;
  readonly keyOf: (row: T) => string;
}

function pageRankedFamily<T>(input: RankedFamilyPageInput<T>): RankedPage<T> {
  const { selected, window, limit, afterKey, done, keyOf } = input;
  if (!selected) return { rows: [], hasMore: false, cursorInvalid: false };
  const after = resolveStableAnchor(window, afterKey, done, keyOf);
  if (after === null) return { rows: [], hasMore: false, cursorInvalid: true };
  const page = pageSorted(window, limit, after, done, keyOf);
  return { rows: page.rows, hasMore: page.hasMore, cursorInvalid: false };
}

function optionalFamilySlice<T>(
  selected: boolean,
  all: readonly T[],
  window: readonly T[],
  page: RankedPage<T>,
): {
  readonly rows?: readonly T[];
  readonly summary?: ArchitectureFamilySummary;
  readonly hasMore: boolean;
} {
  if (!selected) return { hasMore: false };
  return {
    rows: page.rows,
    summary: {
      totalAvailable: all.length,
      selectedCount: window.length,
      pageReturned: page.rows.length,
    },
    hasMore: page.hasMore,
  };
}

/** Build labelled architecture metrics for one filtered catalog generation. */
export function buildArchitectureView(
  catalog: Catalog,
  indexes: Indexes,
  query: ArchitectureViewQuery,
  matcher: SourceRoleMatcher,
  cachedFeatures?: FeatureTable,
): Result<ArchitectureView, GraphReadError> {
  try {
    const filter = query.filter;
    const limit = Math.max(1, Math.min(500, Math.trunc(query.limit)));
    const sections = normalizeSections(query.sections);
    const topN = resolveTopN(query.topN);
    const includeMetrics = wantsSection(sections, 'metrics');
    const includePackageEdges = wantsSection(sections, 'packageEdges');
    const includeHotspots = wantsSection(sections, 'hotspots');
    const reasons = new Set<string>();
    if (resolutionMode(catalog) === 'fast') reasons.add('fast-resolution-approximate');

    const counts = includeMetrics
      ? countArchitectureNodes(indexes, filter, reasons, matcher)
      : { occurrenceCount: 0, bodyHashes: new Set<string>(), packageNames: new Set<string>() };
    const familyInput: ArchitectureFamilyInput = {
      catalog,
      indexes,
      filter,
      reasons,
      cachedFeatures,
      matcher,
    };
    const packageEdges = includePackageEdges ? buildPackageEdges(familyInput) : [];
    const hotspots = includeHotspots ? buildHotspots(familyInput) : [];
    const packageWindow = includePackageEdges ? packageEdges.slice(0, topN) : [];
    const hotspotWindow = includeHotspots ? hotspots.slice(0, topN) : [];

    const packagePage = pageRankedFamily({
      selected: includePackageEdges,
      window: packageWindow,
      limit,
      afterKey: query.afterPackageEdgeKey,
      done: query.packageEdgesDone === true,
      keyOf: packageEdgeStableKey,
    });
    const hotspotPage = pageRankedFamily({
      selected: includeHotspots,
      window: hotspotWindow,
      limit,
      afterKey: query.afterHotspotKey,
      done: query.hotspotsDone === true,
      keyOf: hotspotStableKey,
    });
    if (packagePage.cursorInvalid || hotspotPage.cursorInvalid) {
      return err({
        code: 'cursor-invalid',
        operation: 'analysis',
        message: 'Cursor continuation anchor is not present in this architecture view',
      });
    }
    const grouped = architectureGroups(packageWindow, hotspotWindow, query.groupBy ?? 'none');
    if (grouped?.truncated === true) reasons.add('group-key-cap');
    const callEvidence = includeMetrics
      ? buildCallMetrics(catalog, indexes, filter, reasons, matcher)
      : emptyCallMetrics(filter, catalog);
    const reasonValues = [...reasons].sort(compareCodePointStrings);
    const edgeSlice = optionalFamilySlice(
      includePackageEdges,
      packageEdges,
      packageWindow,
      packagePage,
    );
    const hotspotSlice = optionalFamilySlice(includeHotspots, hotspots, hotspotWindow, hotspotPage);

    return ok({
      languages: [catalog.language],
      occurrenceCount: {
        value: counts.occurrenceCount,
        nodeIdentity: 'occurrence',
        sourceScope: filter.sourceScope,
        generated: filter.generated,
      },
      uniqueBodyCount: {
        value: counts.bodyHashes.size,
        nodeIdentity: 'body-hash',
        sourceScope: filter.sourceScope,
        generated: filter.generated,
      },
      callEvidence,
      packageCount: {
        value: counts.packageNames.size,
        nodeIdentity: 'package',
        sourceScope: filter.sourceScope,
        generated: filter.generated,
      },
      includedSections: sections,
      ...(edgeSlice.rows === undefined
        ? {}
        : { packageEdges: edgeSlice.rows, packageEdgesSummary: edgeSlice.summary }),
      packageEdgesHasMore: edgeSlice.hasMore,
      ...(hotspotSlice.rows === undefined
        ? {}
        : { hotspots: hotspotSlice.rows, hotspotsSummary: hotspotSlice.summary }),
      hotspotsHasMore: hotspotSlice.hasMore,
      effectiveFilter: filter,
      coverage: {
        complete: reasonValues.length === 0,
        truncated: reasonValues.some((reason) => reason.endsWith('-cap')),
        reasons: reasonValues,
      },
      ...(grouped === undefined ? {} : { groups: grouped.groups }),
    });
  } catch (error) {
    return failGraphRead(error, {
      boundary: 'projection',
      condition: 'architecture-projection',
      module: 'graph:read:architecture',
      reason: 'query-invalid',
      operation: 'analysis',
      message: 'Failed to build architecture view',
    });
  }
}

function emptyCallMetrics(filter: GraphSourceFilter, catalog: Catalog): CallEvidenceMetrics {
  return {
    resolvedCallSites: 0,
    resolvedTargets: 0,
    unresolvedCallSites: 0,
    confidence: {},
    resolution: {},
    distributionCountUnit: 'resolved-targets-plus-unresolved-call-sites',
    resolvedTargetConfidence: { values: {}, countUnit: RESOLVED_TARGETS_UNIT },
    resolvedTargetResolution: { values: {}, countUnit: RESOLVED_TARGETS_UNIT },
    unresolvedCallSiteConfidence: { values: {}, countUnit: 'unresolved-call-sites' },
    unresolvedCallSiteResolution: { values: {}, countUnit: 'unresolved-call-sites' },
    nodeIdentity: 'occurrence',
    sourceScope: filter.sourceScope,
    generated: filter.generated,
    edgeKind: 'call',
    catalogResolutionMode: resolutionMode(catalog),
  };
}
