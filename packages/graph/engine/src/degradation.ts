import type { Catalog, GraphRunDegradation } from './types.js';
import type { Signal } from '@opensip-cli/core';

export type { GraphDegradationCondition, GraphRunDegradation } from './types.js';

/** Engine-side identity for graph's run-level coverage diagnostic. */
export const GRAPH_PARTIAL_COVERAGE_SLUG = 'graph:catalog-partial-coverage';

/** Derive run-level degradation evidence from a catalog's persisted coverage. */
export function catalogGraphDegradations(
  catalog: Pick<Catalog, 'buildCoverage'> | null | undefined,
): readonly GraphRunDegradation[] {
  const coverage = catalog?.buildCoverage;
  if (coverage?.status !== 'partial') return [];
  const degradations = [...(coverage.degradations ?? [])];
  if (coverage.parseErrorFiles > 0) {
    degradations.unshift({
      errorCode: 'GRAPH.CATALOG.PARTIAL_COVERAGE',
      condition: 'parse-errors',
      count: coverage.parseErrorFiles,
    });
  }
  return degradations.length > 0
    ? degradations
    : [
        {
          errorCode: 'GRAPH.CATALOG.PARTIAL_COVERAGE',
          condition: 'catalog-coverage-partial',
          count: 1,
        },
      ];
}

/** Convert surviving-shard build evidence into one bounded D9 marker. */
export function shardGraphDegradations(
  failedShardIds: readonly string[],
): readonly GraphRunDegradation[] {
  return failedShardIds.length === 0
    ? []
    : [
        {
          errorCode: 'GRAPH.CATALOG.PARTIAL_COVERAGE',
          condition: 'shard-failures',
          count: failedShardIds.length,
        },
      ];
}

/** Merge repeated conditions (for example, independent multi-path builds). */
export function mergeGraphDegradations(
  values: readonly (readonly GraphRunDegradation[])[],
): readonly GraphRunDegradation[] {
  const counts = new Map<string, GraphRunDegradation>();
  for (const group of values) {
    for (const value of group) {
      const key = `${value.errorCode}:${value.condition}`;
      const existing = counts.get(key);
      counts.set(key, {
        ...value,
        count: (existing?.count ?? 0) + value.count,
      });
    }
  }
  return [...counts.values()];
}

/** Human-safe wording shared by banners and the structured signal. */
export function graphDegradationMessage(value: GraphRunDegradation): string {
  if (value.condition === 'parse-errors') {
    return `${String(value.count)} file(s) failed to parse — their functions are missing from the graph; the run log names each file.`;
  }
  if (value.condition === 'shard-failures') {
    return `${String(value.count)} graph shard(s) failed; the catalog contains only surviving shard evidence.`;
  }
  if (
    value.condition === 'typescript-exact-resolution' ||
    value.condition === 'typescript-syntactic-resolution'
  ) {
    return `${String(value.count)} TypeScript call site(s) could not be analyzed after a resolver fault; the graph omits those edges.`;
  }
  if (value.condition === 'go-module-manifest' || value.condition === 'rust-cargo-manifest') {
    return `${String(value.count)} language manifest(s) could not be read; affected dependency edges are absent.`;
  }
  if (value.condition === 'go-module-manifest-invalid') {
    return `${String(value.count)} Go module manifest(s) omitted a valid module directive; affected dependency edges are absent.`;
  }
  return 'Graph catalog coverage is partial; one or more discovered inputs are absent.';
}

/** Identify the graph-owned marker without relying on message text. */
export function isGraphDegradationSignal(signal: Signal): boolean {
  return (
    signal.ruleId === GRAPH_PARTIAL_COVERAGE_SLUG ||
    signal.ruleId === 'graph.resilience.catalog-partial-coverage'
  );
}
