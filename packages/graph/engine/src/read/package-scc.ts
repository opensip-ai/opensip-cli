/** Edge-kind-specific package strongly connected components. */

import { err, ok, type Result } from '@opensip-cli/core';

import { codePointSortKey, compareCodePointStrings } from '../code-point-order.js';
import { stronglyConnectedComponents } from '../pipeline/strongly-connected-components.js';

import { coverageFromReasons } from './bounded-view.js';
import {
  buildPackageEvidence,
  type PackageEvidenceQuery,
  type PackageEvidenceView,
  type PackageImportEvidenceRow,
} from './package-evidence.js';

import type { GraphReadCoverage } from './query-contracts.js';
import type { SourceRoleMatcher } from './source-filter.js';
import type { GraphReadError } from './types.js';
import type { Catalog, FeatureTable, Indexes } from '../types.js';

/** Labelled package edge retained as evidence for a strongly connected component. */
export interface PackageCycleProofEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'call' | 'import';
  readonly count: number;
}

/** Cyclic package component and its bounded deterministic proof-edge sample. */
export interface PackageCycleComponent {
  readonly packages: readonly string[];
  readonly proofEdges: readonly PackageCycleProofEdge[];
  readonly totalProofEdges: number;
}

/** Package-cycle components together with evidence coverage metadata. */
export interface PackageSccView {
  readonly components: readonly PackageCycleComponent[];
  readonly coverage: GraphReadCoverage;
}

const MAX_PROOF = 50;

function cycleProofRows(view: PackageEvidenceView): PackageCycleProofEdge[] {
  // Intra-package (self) aggregate edges are excluded from the SCC adjacency
  // (P2 Phase 1.1): a package depending on itself is not a package cycle, and
  // `graph:unexpected-coupling` already ignores package self loops. Same-package
  // rows remain queryable through buildPackageEvidence / package_dependencies —
  // only this SCC projection drops them.
  return [
    ...view.calls
      .filter((row) => row.fromPackage !== row.toPackage)
      .map((row) => ({
        from: row.fromPackage,
        to: row.toPackage,
        kind: 'call' as const,
        count: row.count,
      })),
    ...view.imports
      .filter(
        (row): row is PackageImportEvidenceRow & { toPackage: string } =>
          row.toPackage !== null &&
          row.resolution === 'internal' &&
          row.fromPackage !== row.toPackage,
      )
      .map((row) => ({
        from: row.fromPackage,
        to: row.toPackage,
        kind: 'import' as const,
        count: row.count,
      })),
  ].sort(compareProofEdges);
}

function compareProofEdges(a: PackageCycleProofEdge, b: PackageCycleProofEdge): number {
  return compareCodePointStrings(
    `${codePointSortKey(a.from)}|${codePointSortKey(a.to)}|${a.kind}`,
    `${codePointSortKey(b.from)}|${codePointSortKey(b.to)}|${b.kind}`,
  );
}

function packageAdjacency(proof: readonly PackageCycleProofEdge[]) {
  const adjacency = new Map<string, Set<string>>();
  for (const row of proof) {
    if (!adjacency.has(row.from)) adjacency.set(row.from, new Set());
    adjacency.get(row.from)?.add(row.to);
    if (!adjacency.has(row.to)) adjacency.set(row.to, new Set());
  }
  return adjacency;
}

/**
 * A returned package SCC must contain at least two DISTINCT package labels
 * (P2 Phase 1.1). Self edges are already excluded from the adjacency by
 * {@link cycleProofRows}, so no singleton can carry a self-loop; a lone package
 * is therefore never promoted to a cycle.
 */
function isCycle(members: readonly string[]): boolean {
  return members.length > 1;
}

function projectComponents(
  components: readonly (readonly string[])[],
  proof: readonly PackageCycleProofEdge[],
  reasons: Set<string>,
): PackageCycleComponent[] {
  const projected: {
    readonly packages: readonly string[];
    readonly proofEdges: PackageCycleProofEdge[];
    totalProofEdges: number;
  }[] = [];
  const componentByPackage = new Map<string, (typeof projected)[number]>();
  for (const members of components) {
    if (!isCycle(members)) continue;
    const component: (typeof projected)[number] = {
      packages: members,
      proofEdges: [],
      totalProofEdges: 0,
    };
    projected.push(component);
    for (const member of members) componentByPackage.set(member, component);
  }
  // `proof` is already in stable order, so this single pass preserves the
  // deterministic first-50 proof sample without rescanning it per component.
  for (const row of proof) {
    const component = componentByPackage.get(row.from);
    if (component === undefined || component !== componentByPackage.get(row.to)) continue;
    component.totalProofEdges++;
    if (component.proofEdges.length < MAX_PROOF) component.proofEdges.push(row);
    else reasons.add('proof-edge-cap');
  }
  projected.sort((a, b) => compareCodePointStrings(a.packages.join('\0'), b.packages.join('\0')));
  return projected;
}

/** Package SCCs over the selected labelled edge kind. */
export function buildPackageScc(
  catalog: Catalog,
  indexes: Indexes,
  query: PackageEvidenceQuery,
  matcher: SourceRoleMatcher,
  cachedFeatures?: FeatureTable,
): Result<PackageSccView, GraphReadError> {
  try {
    const evidence = buildPackageEvidence(catalog, indexes, query, matcher, cachedFeatures);
    if (!evidence.ok) return evidence;
    const proof = cycleProofRows(evidence.value);
    const adjacency = packageAdjacency(proof);
    const nodes = [...adjacency.keys()].sort(compareCodePointStrings);
    const components = stronglyConnectedComponents(nodes, (node) =>
      [...(adjacency.get(node) ?? [])].sort(compareCodePointStrings),
    );
    const reasons = new Set(evidence.value.coverage.reasons);
    return ok({
      components: projectComponents(components, proof, reasons),
      coverage: coverageFromReasons(reasons),
    });
  } catch {
    return err({
      code: 'GRAPH.READ.PACKAGE_EVIDENCE',
      operation: 'analysis',
      message: 'Failed to build package SCCs',
    });
  }
}
