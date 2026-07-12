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
import { isCanonicalProductionFilter, matchesGraphSourceFilter } from './source-filter.js';

import type { GraphReadError } from './types.js';
import type { Catalog, FeatureTable, Indexes } from '../types.js';

export interface ArchitectureViewQuery {
  readonly filter: GraphSourceFilter;
  readonly limit: number;
  readonly afterPackageEdgeKey?: string;
  readonly afterHotspotKey?: string;
  readonly packageEdgesDone?: boolean;
  readonly hotspotsDone?: boolean;
  readonly groupBy?: 'none' | 'package' | 'file';
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
  readonly packageEdges: readonly ArchitecturePackageEdgeRow[];
  readonly packageEdgesHasMore: boolean;
  readonly hotspots: readonly ArchitectureHotspot[];
  readonly hotspotsHasMore: boolean;
  readonly effectiveFilter: EffectiveGraphSourceFilter;
  readonly coverage: GraphReadCoverage;
  readonly groups?: readonly ReadGroupSummary[];
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

function archError(message: string): GraphReadError {
  return { code: 'GRAPH.READ.ARCHITECTURE_VIEW', operation: 'analysis', message };
}

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
): ArchitectureCounts {
  const bodyHashes = new Set<string>();
  const packageNames = new Set<string>();
  let occurrenceCount = 0;
  for (const occurrence of indexes.byOccId.values()) {
    if (occurrence.kind === 'module-init' || !matchesGraphSourceFilter(occurrence, filter))
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
      !matchesGraphSourceFilter(edge.owner, filter) ||
      !matchesGraphSourceFilter(edge.target, filter)
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
    if (!matchesGraphSourceFilter(unresolved.owner, filter)) continue;
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
      countUnit: 'resolved-targets',
    },
    resolvedTargetResolution: {
      values: toCountRecord(resolvedResolution),
      countUnit: 'resolved-targets',
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
    countUnit: 'resolved-targets',
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
): ArchitecturePackageEdgeRow[] {
  const buckets = new Map<string, ArchitecturePackageEdgeRow>();
  const graph = occurrenceCallGraphFor(indexes);
  noteMalformedCalls(graph.malformedCalls, reasons);
  for (const edge of graph.edges) {
    if (
      !matchesGraphSourceFilter(edge.owner, filter) ||
      !matchesGraphSourceFilter(edge.target, filter)
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

function buildPackageEdges(
  catalog: Catalog,
  indexes: Indexes,
  filter: GraphSourceFilter,
  reasons: Set<string>,
  cachedFeatures: FeatureTable | undefined,
): ArchitecturePackageEdgeRow[] {
  const rows = isCanonicalProductionFilter(filter)
    ? canonicalPackageEdges(catalog, indexes, filter, reasons, cachedFeatures)
    : filteredPackageEdges(catalog, indexes, filter, reasons);
  const selected = boundedArchitectureRows(rows, MAX_ORIENTATION_ROWS, comparePackageEdges);
  if (selected.truncated) reasons.add('package-edge-cap');
  return [...selected.rows];
}

function buildHotspots(
  catalog: Catalog,
  indexes: Indexes,
  filter: GraphSourceFilter,
  reasons: Set<string>,
  cachedFeatures: FeatureTable | undefined,
): ArchitectureHotspot[] {
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
    if (matchesGraphSourceFilter(symbol, filter)) {
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

/** Build labelled architecture metrics for one filtered catalog generation. */
export function buildArchitectureView(
  catalog: Catalog,
  indexes: Indexes,
  query: ArchitectureViewQuery,
  cachedFeatures?: FeatureTable,
): Result<ArchitectureView, GraphReadError> {
  try {
    const filter = query.filter;
    const limit = Math.max(1, Math.min(500, Math.trunc(query.limit)));
    const reasons = new Set<string>();
    if (resolutionMode(catalog) === 'fast') reasons.add('fast-resolution-approximate');
    const counts = countArchitectureNodes(indexes, filter, reasons);
    const packageEdges = buildPackageEdges(catalog, indexes, filter, reasons, cachedFeatures);
    const hotspots = buildHotspots(catalog, indexes, filter, reasons, cachedFeatures);
    const packageAfter = resolveStableAnchor(
      packageEdges,
      query.afterPackageEdgeKey,
      query.packageEdgesDone === true,
      packageEdgeStableKey,
    );
    const hotspotAfter = resolveStableAnchor(
      hotspots,
      query.afterHotspotKey,
      query.hotspotsDone === true,
      hotspotStableKey,
    );
    if (packageAfter === null || hotspotAfter === null) {
      return err({
        code: 'GRAPH.READ.CURSOR_INVALID',
        operation: 'analysis',
        message: 'Cursor continuation anchor is not present in this architecture view',
      });
    }
    const packagePage = pageSorted(
      packageEdges,
      limit,
      packageAfter,
      query.packageEdgesDone === true,
      packageEdgeStableKey,
    );
    const hotspotPage = pageSorted(
      hotspots,
      limit,
      hotspotAfter,
      query.hotspotsDone === true,
      hotspotStableKey,
    );
    const grouped = architectureGroups(packageEdges, hotspots, query.groupBy ?? 'none');
    if (grouped?.truncated === true) reasons.add('group-key-cap');
    const callEvidence = buildCallMetrics(catalog, indexes, filter, reasons);
    const reasonValues = [...reasons].sort(compareCodePointStrings);

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
      packageEdges: packagePage.rows,
      packageEdgesHasMore: packagePage.hasMore,
      hotspots: hotspotPage.rows,
      hotspotsHasMore: hotspotPage.hasMore,
      effectiveFilter: filter,
      coverage: {
        complete: reasonValues.length === 0,
        truncated: reasonValues.some((reason) => reason.endsWith('-cap')),
        reasons: reasonValues,
      },
      ...(grouped === undefined ? {} : { groups: grouped.groups }),
    });
  } catch {
    return err(archError('Failed to build architecture view'));
  }
}
