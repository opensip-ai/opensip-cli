/**
 * Package call/import evidence + package SCC views.
 */

import { err, ok, type Result } from '@opensip-cli/core';

import { buildFeatures } from '../pipeline/features.js';
import { buildOccurrenceCallGraph } from '../pipeline/occurrence-call-graph.js';
import { stronglyConnectedComponents } from '../pipeline/strongly-connected-components.js';
import { pkgOf } from '../resolve-callee.js';

import {
  toGraphSymbolRef,
  type GraphSourceFilter,
  type PackageEdgeKind,
} from './query-contracts.js';
import { matchesGraphSourceFilter } from './source-filter.js';

import type { GraphReadError } from './types.js';
import type { Catalog, Indexes, PackageEdgeFeature } from '../types.js';

export interface PackageEvidenceQuery {
  readonly edgeKind: PackageEdgeKind;
  readonly filter: GraphSourceFilter;
  readonly fromPackage?: string;
  readonly toPackage?: string;
}

export interface PackageCallEvidenceRow {
  readonly fromPackage: string;
  readonly toPackage: string;
  readonly kind: 'call';
  readonly count: number;
  readonly countUnit: 'call-sites';
  readonly sample: readonly {
    readonly from: NonNullable<ReturnType<typeof toGraphSymbolRef>>;
    readonly to: NonNullable<ReturnType<typeof toGraphSymbolRef>>;
    readonly line: number;
    readonly column: number;
    readonly resolution: string;
    readonly confidence: string;
    readonly crossShard: boolean;
  }[];
}

export interface PackageImportEvidenceRow {
  readonly fromPackage: string;
  readonly toPackage: string | null;
  readonly kind: 'import';
  readonly specifier: string;
  readonly external: boolean;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
}

export interface PackageEvidenceView {
  readonly calls: readonly PackageCallEvidenceRow[];
  readonly imports: readonly PackageImportEvidenceRow[];
  readonly coverage: {
    readonly complete: boolean;
    readonly truncated: boolean;
    readonly reasons: readonly string[];
  };
}

export interface PackageCycleComponent {
  readonly packages: readonly string[];
  readonly proofEdges: readonly {
    readonly from: string;
    readonly to: string;
    readonly kind: string;
  }[];
  readonly totalProofEdges: number;
}

export interface PackageSccView {
  readonly components: readonly PackageCycleComponent[];
  readonly coverage: {
    readonly complete: boolean;
    readonly truncated: boolean;
    readonly reasons: readonly string[];
  };
}

const MAX_SPECIFIER = 512;
const MAX_PROOF = 50;

function stripControls(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.codePointAt(i) ?? 0;
    if (code > 0x1f && code !== 0x7f) out += value[i];
  }
  return out;
}

function peError(message: string): GraphReadError {
  return { code: 'GRAPH.READ.PACKAGE_EVIDENCE', operation: 'analysis', message };
}

/**
 * Build package call/import evidence.
 * Default production/non-generated call counts reuse FeatureTable.edge.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- single package evidence aggregation over call+import filters
export function buildPackageEvidence(
  catalog: Catalog,
  indexes: Indexes,
  query: PackageEvidenceQuery,
): Result<PackageEvidenceView, GraphReadError> {
  try {
    const reasons: string[] = [];
    let calls: PackageCallEvidenceRow[] = [];
    const imports: PackageImportEvidenceRow[] = [];

    if (query.edgeKind === 'call' || query.edgeKind === 'combined') {
      const useCanonical =
        query.filter.sourceScope === 'production' &&
        query.filter.generated === 'exclude' &&
        query.filter.packages === undefined &&
        query.filter.filePath === undefined &&
        query.filter.filePrefix === undefined &&
        query.filter.kinds === undefined &&
        query.filter.visibilities === undefined;

      if (useCanonical) {
        const features = buildFeatures(catalog, indexes, {}, ['packageCoupling']);
        calls = features.edge
          .filter(
            (e) =>
              (query.fromPackage === undefined || e.callerPackage === query.fromPackage) &&
              (query.toPackage === undefined || e.calleePackage === query.toPackage),
          )
          .map((e: PackageEdgeFeature) => ({
            fromPackage: e.callerPackage,
            toPackage: e.calleePackage,
            kind: 'call' as const,
            count: e.count,
            countUnit: 'call-sites' as const,
            sample: [],
          }));
      } else {
        const graph = buildOccurrenceCallGraph(indexes);
        const buckets = new Map<string, PackageCallEvidenceRow>();
        for (const edge of graph.edges) {
          if (
            !matchesGraphSourceFilter(edge.owner, query.filter) ||
            !matchesGraphSourceFilter(edge.target, query.filter)
          ) {
            continue;
          }
          const fromP = pkgOf(edge.owner);
          const toP = pkgOf(edge.target);
          if (fromP === toP) continue;
          if (query.fromPackage !== undefined && fromP !== query.fromPackage) continue;
          if (query.toPackage !== undefined && toP !== query.toPackage) continue;
          const key = `${fromP}\0${toP}`;
          const from = toGraphSymbolRef(edge.owner);
          const to = toGraphSymbolRef(edge.target);
          const existing = buckets.get(key);
          if (existing === undefined) {
            buckets.set(key, {
              fromPackage: fromP,
              toPackage: toP,
              kind: 'call',
              count: 1,
              countUnit: 'call-sites',
              sample:
                from && to
                  ? [
                      {
                        from,
                        to,
                        line: edge.callSite.line,
                        column: edge.callSite.column,
                        resolution: edge.resolution,
                        confidence: edge.confidence,
                        crossShard: edge.crossShard,
                      },
                    ]
                  : [],
            });
          } else {
            buckets.set(key, {
              ...existing,
              count: existing.count + 1,
              sample:
                existing.sample.length < 5 && from && to
                  ? [
                      ...existing.sample,
                      {
                        from,
                        to,
                        line: edge.callSite.line,
                        column: edge.callSite.column,
                        resolution: edge.resolution,
                        confidence: edge.confidence,
                        crossShard: edge.crossShard,
                      },
                    ]
                  : existing.sample,
            });
          }
        }
        calls = [...buckets.values()].sort((a, b) =>
          a.fromPackage === b.fromPackage
            ? a.toPackage.localeCompare(b.toPackage)
            : a.fromPackage.localeCompare(b.fromPackage),
        );
      }
    }

    if (query.edgeKind === 'import' || query.edgeKind === 'combined') {
      let sawDependencies = false;
      for (const occ of indexes.byOccId.values()) {
        if (occ.kind !== 'module-init') continue;
        if (!matchesGraphSourceFilter(occ, query.filter)) continue;
        if (occ.dependencies === undefined) {
          continue;
        }
        sawDependencies = true;
        const fromP = pkgOf(occ);
        if (query.fromPackage !== undefined && fromP !== query.fromPackage) continue;
        for (const dep of occ.dependencies) {
          const specifier =
            dep.specifier.length > MAX_SPECIFIER
              ? dep.specifier.slice(0, MAX_SPECIFIER)
              : stripControls(dep.specifier);
          let toPackage: string | null = null;
          let external = dep.to.length === 0;
          if (dep.to.length > 0) {
            const target = indexes.byBodyHash.get(dep.to[0]);
            if (target) toPackage = pkgOf(target);
            else external = true;
          }
          if (query.toPackage !== undefined && toPackage !== query.toPackage) continue;
          imports.push({
            fromPackage: fromP,
            toPackage,
            kind: 'import',
            specifier,
            external,
            filePath: occ.filePath,
            line: dep.line,
            column: dep.column,
          });
        }
      }
      if (!sawDependencies) {
        reasons.push('dependency-edges-unavailable');
      }
    }

    return ok({
      calls,
      imports,
      coverage: {
        complete: reasons.length === 0,
        truncated: false,
        reasons,
      },
    });
  } catch {
    return err(peError('Failed to build package evidence'));
  }
}

/** Package SCCs over selected edge kind. */
// eslint-disable-next-line sonarjs/cognitive-complexity -- package SCC projection with proof edges
export function buildPackageScc(
  catalog: Catalog,
  indexes: Indexes,
  query: PackageEvidenceQuery,
): Result<PackageSccView, GraphReadError> {
  try {
    const evidence = buildPackageEvidence(catalog, indexes, query);
    if (!evidence.ok) return evidence;
    const adj = new Map<string, Set<string>>();
    const proof: { from: string; to: string; kind: string }[] = [];
    for (const row of evidence.value.calls) {
      if (!adj.has(row.fromPackage)) adj.set(row.fromPackage, new Set());
      adj.get(row.fromPackage)!.add(row.toPackage);
      if (!adj.has(row.toPackage)) adj.set(row.toPackage, new Set());
      proof.push({ from: row.fromPackage, to: row.toPackage, kind: 'call' });
    }
    for (const row of evidence.value.imports) {
      if (row.toPackage === null || row.external) continue;
      if (!adj.has(row.fromPackage)) adj.set(row.fromPackage, new Set());
      adj.get(row.fromPackage)!.add(row.toPackage);
      if (!adj.has(row.toPackage)) adj.set(row.toPackage, new Set());
      proof.push({ from: row.fromPackage, to: row.toPackage, kind: 'import' });
    }
    const nodes = [...adj.keys()].sort();
    const components = stronglyConnectedComponents(nodes, (v) => [...(adj.get(v) ?? [])]);
    const out: PackageCycleComponent[] = [];
    for (const members of components) {
      if (members.length < 2 && !(members.length === 1 && adj.get(members[0])?.has(members[0]))) {
        continue;
      }
      const memberSet = new Set(members);
      const proving = proof.filter((p) => memberSet.has(p.from) && memberSet.has(p.to));
      out.push({
        packages: members,
        proofEdges: proving.slice(0, MAX_PROOF),
        totalProofEdges: proving.length,
      });
    }
    const truncated = out.some((c) => c.totalProofEdges > MAX_PROOF);
    return ok({
      components: out,
      coverage: {
        complete: !truncated,
        truncated,
        reasons: truncated ? ['proof-edge-cap'] : [],
      },
    });
  } catch {
    return err(peError('Failed to build package SCCs'));
  }
}
