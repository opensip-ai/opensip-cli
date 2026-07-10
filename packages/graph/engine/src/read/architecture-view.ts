/**
 * Labelled architecture audit metrics over filtered catalog evidence.
 *
 * Metrics keep distinct units/scopes:
 * - occurrence count vs unique body-hash count
 * - resolved call-site/target counts vs unresolved call-sites
 * - confidence/resolution distributions with edge-kind + catalog mode labels
 * - canonical FeatureTable.edge package call rows (production/non-generated default)
 * - blast hotspots filtered before ranking (body-twin score semantics)
 *
 * Target-convention summaries stay MCP/host-side; they are not computed here.
 */

import { err, ok, type Result } from '@opensip-cli/core';

import { buildFeatures } from '../pipeline/features.js';
import { buildOccurrenceCallGraph } from '../pipeline/occurrence-call-graph.js';
import { pkgOf } from '../resolve-callee.js';

import {
  toGraphSymbolRef,
  type EffectiveGraphSourceFilter,
  type GeneratedPolicy,
  type GraphReadCoverage,
  type GraphSourceFilter,
  type GraphSymbolRef,
  type SourceScope,
} from './query-contracts.js';
import { matchesGraphSourceFilter } from './source-filter.js';

import type { GraphReadError } from './types.js';
import type { Catalog, Indexes, PackageEdgeFeature } from '../types.js';

export interface ArchitectureViewQuery {
  readonly filter: GraphSourceFilter;
  /** Cap for package edge + hotspot orientation rows (retains limit+1 each). */
  readonly limit: number;
  readonly afterPackageEdgeKey?: string;
  readonly afterHotspotKey?: string;
}

/** Count labelled with node identity and source/generated scope. */
export interface LabelledNodeCount {
  readonly value: number;
  readonly nodeIdentity: 'occurrence' | 'body-hash';
  readonly sourceScope: SourceScope;
  readonly generated: GeneratedPolicy;
}

export interface CallEvidenceMetrics {
  /** Resolved call-site rows with at least one surviving target under the filter. */
  readonly resolvedCallSites: number;
  /** Resolved occurrence→occurrence target edges under the filter. */
  readonly resolvedTargets: number;
  readonly unresolvedCallSites: number;
  readonly confidence: Readonly<Record<string, number>>;
  readonly resolution: Readonly<Record<string, number>>;
  readonly edgeKind: 'call';
  readonly catalogResolutionMode: 'exact' | 'fast' | undefined;
}

export interface ArchitecturePackageEdgeRow {
  readonly fromPackage: string;
  readonly toPackage: string;
  readonly kind: 'call';
  readonly count: number;
  readonly countUnit: 'call-sites';
}

export interface ArchitectureHotspot {
  readonly symbol: GraphSymbolRef;
  readonly direct: number;
  readonly transitive: number;
  readonly score: number;
  readonly identityMode: 'body-twin-union';
  readonly twinCount: number;
}

export interface ArchitectureView {
  readonly languages: readonly string[];
  readonly occurrenceCount: LabelledNodeCount;
  readonly uniqueBodyCount: LabelledNodeCount;
  readonly callEvidence: CallEvidenceMetrics;
  readonly packageCount: number;
  readonly packageEdges: readonly ArchitecturePackageEdgeRow[];
  readonly packageEdgesHasMore: boolean;
  readonly hotspots: readonly ArchitectureHotspot[];
  readonly hotspotsHasMore: boolean;
  readonly effectiveFilter: EffectiveGraphSourceFilter;
  readonly coverage: GraphReadCoverage;
}

function archError(message: string): GraphReadError {
  return { code: 'GRAPH.READ.ARCHITECTURE_VIEW', operation: 'analysis', message };
}

export function packageEdgeStableKey(row: ArchitecturePackageEdgeRow): string {
  return `${row.fromPackage}\0${row.toPackage}`;
}

export function hotspotStableKey(row: ArchitectureHotspot): string {
  // Score desc, then symbolId asc — encode score as inverted padded for string order.
  const scoreKey = String(1_000_000_000 - Math.trunc(row.score * 1000)).padStart(12, '0');
  return `${scoreKey}\0${row.symbol.symbolId}`;
}

function isCanonicalPackagePath(filter: GraphSourceFilter): boolean {
  return (
    filter.sourceScope === 'production' &&
    filter.generated === 'exclude' &&
    filter.packages === undefined &&
    filter.filePath === undefined &&
    filter.filePrefix === undefined &&
    filter.kinds === undefined &&
    filter.visibilities === undefined
  );
}

/**
 * Build labelled architecture metrics for the filtered catalog generation.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- labelled multi-metric architecture aggregation
export function buildArchitectureView(
  catalog: Catalog,
  indexes: Indexes,
  query: ArchitectureViewQuery,
): Result<ArchitectureView, GraphReadError> {
  try {
    const limit = Math.max(1, Math.min(500, Math.trunc(query.limit)));
    const filter = query.filter;
    const reasons: string[] = [];

    // --- occurrence / body counts ---
    const bodyHashes = new Set<string>();
    let occurrenceCount = 0;
    for (const occ of indexes.byOccId.values()) {
      if (occ.kind === 'module-init') continue;
      if (!matchesGraphSourceFilter(occ, filter)) continue;
      occurrenceCount++;
      bodyHashes.add(occ.bodyHash);
    }

    // --- call evidence from occurrence call graph ---
    const graph = buildOccurrenceCallGraph(indexes);
    const confidence: Record<string, number> = {};
    const resolution: Record<string, number> = {};
    let resolvedCallSites = 0;
    let resolvedTargets = 0;
    let unresolvedCallSites = 0;

    // Group resolved edges by owner+callSite to count call-sites vs targets.
    const resolvedSiteKeys = new Set<string>();
    for (const edge of graph.edges) {
      if (
        !matchesGraphSourceFilter(edge.owner, filter) ||
        !matchesGraphSourceFilter(edge.target, filter)
      ) {
        continue;
      }
      const siteKey = `${edge.fromOccId}\0${String(edge.callSite.line)}\0${String(edge.callSite.column)}`;
      if (!resolvedSiteKeys.has(siteKey)) {
        resolvedSiteKeys.add(siteKey);
        resolvedCallSites++;
      }
      resolvedTargets++;
      confidence[edge.confidence] = (confidence[edge.confidence] ?? 0) + 1;
      resolution[edge.resolution] = (resolution[edge.resolution] ?? 0) + 1;
    }
    for (const u of graph.unresolved) {
      if (!matchesGraphSourceFilter(u.owner, filter)) continue;
      unresolvedCallSites++;
      confidence[u.confidence] = (confidence[u.confidence] ?? 0) + 1;
      resolution[u.resolution] = (resolution[u.resolution] ?? 0) + 1;
    }

    // --- package edges ---
    let packageEdgesAll: ArchitecturePackageEdgeRow[] = [];
    const packageNames = new Set<string>();

    if (isCanonicalPackagePath(filter)) {
      const features = buildFeatures(catalog, indexes, {}, ['packageCoupling']);
      for (const [name] of features.package) packageNames.add(name);
      packageEdgesAll = features.edge
        .filter((e: PackageEdgeFeature) => e.callerPackage !== e.calleePackage)
        .map((e: PackageEdgeFeature) => ({
          fromPackage: e.callerPackage,
          toPackage: e.calleePackage,
          kind: 'call' as const,
          count: e.count,
          countUnit: 'call-sites' as const,
        }));
    } else {
      const buckets = new Map<string, ArchitecturePackageEdgeRow>();
      for (const edge of graph.edges) {
        if (
          !matchesGraphSourceFilter(edge.owner, filter) ||
          !matchesGraphSourceFilter(edge.target, filter)
        ) {
          continue;
        }
        const fromP = pkgOf(edge.owner);
        const toP = pkgOf(edge.target);
        packageNames.add(fromP);
        packageNames.add(toP);
        if (fromP === toP) continue;
        const key = `${fromP}\0${toP}`;
        const existing = buckets.get(key);
        if (existing === undefined) {
          buckets.set(key, {
            fromPackage: fromP,
            toPackage: toP,
            kind: 'call',
            count: 1,
            countUnit: 'call-sites',
          });
        } else {
          buckets.set(key, { ...existing, count: existing.count + 1 });
        }
      }
      // Also count filtered packages with no edges.
      for (const occ of indexes.byOccId.values()) {
        if (occ.kind === 'module-init') continue;
        if (!matchesGraphSourceFilter(occ, filter)) continue;
        packageNames.add(pkgOf(occ));
      }
      packageEdgesAll = [...buckets.values()];
    }

    packageEdgesAll.sort((a, b) => {
      const scoreA = a.count;
      const scoreB = b.count;
      if (scoreB !== scoreA) return scoreB - scoreA;
      if (a.fromPackage < b.fromPackage) return -1;
      if (a.fromPackage > b.fromPackage) return 1;
      if (a.toPackage < b.toPackage) return -1;
      if (a.toPackage > b.toPackage) return 1;
      return 0;
    });

    const packageEdgesWindow = sliceAfterKey(
      packageEdgesAll,
      limit,
      query.afterPackageEdgeKey,
      packageEdgeStableKey,
    );

    // --- blast hotspots (filter occurrences first, rank by body-twin score) ---
    const features = buildFeatures(catalog, indexes, {}, ['blast']);
    const twinCounts = new Map<string, number>();
    for (const occ of indexes.byOccId.values()) {
      if (occ.kind === 'module-init') continue;
      twinCounts.set(occ.bodyHash, (twinCounts.get(occ.bodyHash) ?? 0) + 1);
    }

    const hotspotCandidates: ArchitectureHotspot[] = [];
    const seenBodies = new Set<string>();
    for (const occ of indexes.byOccId.values()) {
      if (occ.kind === 'module-init') continue;
      if (!matchesGraphSourceFilter(occ, filter)) continue;
      if (seenBodies.has(occ.bodyHash)) continue;
      seenBodies.add(occ.bodyHash);
      const blast = features.function.get(occ.bodyHash)?.blast;
      if (blast === undefined) continue;
      const symbol = toGraphSymbolRef(occ);
      if (symbol === undefined) {
        reasons.push('malformed-symbol-omitted');
        continue;
      }
      hotspotCandidates.push({
        symbol,
        direct: blast.direct,
        transitive: blast.transitive,
        score: blast.score,
        identityMode: 'body-twin-union',
        twinCount: twinCounts.get(occ.bodyHash) ?? 1,
      });
    }
    hotspotCandidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.symbol.symbolId < b.symbol.symbolId) return -1;
      if (a.symbol.symbolId > b.symbol.symbolId) return 1;
      return 0;
    });
    const hotspotsWindow = sliceAfterKey(
      hotspotCandidates,
      limit,
      query.afterHotspotKey,
      hotspotStableKey,
    );

    const uniqueReasons = [...new Set(reasons)];
    return ok({
      languages: [catalog.language],
      occurrenceCount: {
        value: occurrenceCount,
        nodeIdentity: 'occurrence',
        sourceScope: filter.sourceScope,
        generated: filter.generated,
      },
      uniqueBodyCount: {
        value: bodyHashes.size,
        nodeIdentity: 'body-hash',
        sourceScope: filter.sourceScope,
        generated: filter.generated,
      },
      callEvidence: {
        resolvedCallSites,
        resolvedTargets,
        unresolvedCallSites,
        confidence,
        resolution,
        edgeKind: 'call',
        catalogResolutionMode: catalog.resolutionMode,
      },
      packageCount: packageNames.size,
      packageEdges: packageEdgesWindow.rows,
      packageEdgesHasMore: packageEdgesWindow.hasMore,
      hotspots: hotspotsWindow.rows,
      hotspotsHasMore: hotspotsWindow.hasMore,
      effectiveFilter: filter,
      coverage: {
        complete: uniqueReasons.length === 0,
        truncated: false,
        reasons: uniqueReasons,
      },
    });
  } catch {
    return err(archError('Failed to build architecture view'));
  }
}

function sliceAfterKey<T>(
  sorted: readonly T[],
  limit: number,
  afterKey: string | undefined,
  keyOf: (row: T) => string,
): { rows: readonly T[]; hasMore: boolean } {
  const out: T[] = [];
  let hasMore = false;
  for (const row of sorted) {
    const key = keyOf(row);
    if (afterKey !== undefined && key <= afterKey) continue;
    if (out.length < limit) {
      out.push(row);
      continue;
    }
    hasMore = true;
    break;
  }
  return { rows: out, hasMore };
}
