import { graphErrorCatalog } from './errors/graph-error-catalog.js';

import type { Catalog } from './types.js';
import type { Signal } from '@opensip-cli/core';

/** Engine-side identity for graph's run-level coverage diagnostic. */
export const GRAPH_PARTIAL_COVERAGE_SLUG = 'graph:catalog-partial-coverage';

/** Registered definition linked from every structured coverage marker. */
export const GRAPH_PARTIAL_COVERAGE = graphErrorCatalog.require('GRAPH.CATALOG.PARTIAL_COVERAGE');

/** Closed D9 condition vocabulary for graph coverage degradation. */
export type GraphDegradationCondition =
  'catalog-coverage-partial' | 'parse-errors' | 'shard-failures';

/** Plain-data coverage evidence that survives graph's worker boundaries. */
export interface GraphRunDegradation {
  readonly condition: GraphDegradationCondition;
  readonly count: number;
}

/** Derive run-level degradation evidence from a catalog's persisted coverage. */
export function catalogGraphDegradations(
  catalog: Pick<Catalog, 'buildCoverage'> | null | undefined,
): readonly GraphRunDegradation[] {
  const coverage = catalog?.buildCoverage;
  if (coverage?.status !== 'partial') return [];
  if (coverage.parseErrorFiles > 0) {
    return [{ condition: 'parse-errors', count: coverage.parseErrorFiles }];
  }
  return [{ condition: 'catalog-coverage-partial', count: 1 }];
}

/** Convert surviving-shard build evidence into one bounded D9 marker. */
export function shardGraphDegradations(
  failedShardIds: readonly string[],
): readonly GraphRunDegradation[] {
  return failedShardIds.length === 0
    ? []
    : [{ condition: 'shard-failures', count: failedShardIds.length }];
}

/** Merge repeated conditions (for example, independent multi-path builds). */
export function mergeGraphDegradations(
  values: readonly (readonly GraphRunDegradation[])[],
): readonly GraphRunDegradation[] {
  const counts = new Map<GraphDegradationCondition, number>();
  for (const group of values) {
    for (const value of group) {
      counts.set(value.condition, (counts.get(value.condition) ?? 0) + value.count);
    }
  }
  return [...counts].map(([condition, count]) => ({ condition, count }));
}

/** Human-safe wording shared by banners and the structured signal. */
export function graphDegradationMessage(value: GraphRunDegradation): string {
  if (value.condition === 'parse-errors') {
    return `${String(value.count)} file(s) failed to parse — their functions are missing from the graph; the run log names each file.`;
  }
  if (value.condition === 'shard-failures') {
    return `${String(value.count)} graph shard(s) failed; the catalog contains only surviving shard evidence.`;
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
