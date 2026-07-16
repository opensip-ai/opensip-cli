import {
  DEFAULT_MAX_DEPTH,
  catalogUncertainties,
  changedFileEntryUncertainties,
  compareImpactText,
  impactReason,
  impactResultLimit,
  malformedImpactUncertainty,
  remainingImpactLimit,
  toImpactFunction,
  truncatedImpactUncertainty,
} from './graph-impact-shared.js';
import { buildImpactTrust, mergeImpactUncertainties } from './impact-trust.js';

import type { GraphCatalog, GraphFunctionOccurrence } from './graph-catalog.js';
import type {
  ComputeImpactOptions,
  ImpactComputation,
  ImpactFunction,
  ImpactPackage,
} from './graph-impact-model.js';

interface SynchronousImpactIndex {
  readonly occurrences: readonly GraphFunctionOccurrence[];
  readonly occurrenceOrdinal: ReadonlyMap<GraphFunctionOccurrence, number>;
  readonly reverseAdjacency: ReadonlyMap<string, readonly number[]>;
  readonly catalogFiles: ReadonlySet<string>;
  readonly catalogApproximate: boolean;
}

interface SynchronousIndexState {
  readonly occurrences: GraphFunctionOccurrence[];
  readonly occurrenceOrdinal: Map<GraphFunctionOccurrence, number>;
  readonly reverse: Map<string, Set<number>>;
  readonly catalogFiles: Set<string>;
  approximate: boolean;
}

function addSynchronousReverseEdges(
  state: SynchronousIndexState,
  occurrence: GraphFunctionOccurrence,
  ordinal: number,
): void {
  const calls: unknown = occurrence.calls;
  if (!Array.isArray(calls)) {
    state.approximate = true;
    return;
  }
  for (const rawEdge of calls) {
    if (typeof rawEdge !== 'object' || rawEdge === null) {
      state.approximate = true;
      continue;
    }
    const edge = rawEdge as Record<string, unknown>;
    if (edge.confidence !== 'high' || edge.resolution === 'syntactic') state.approximate = true;
    if (!Array.isArray(edge.to)) {
      state.approximate = true;
      continue;
    }
    for (const target of edge.to) {
      if (typeof target !== 'string') {
        state.approximate = true;
        continue;
      }
      const callers = state.reverse.get(target) ?? new Set<number>();
      callers.add(ordinal);
      state.reverse.set(target, callers);
    }
  }
}

function addSynchronousOccurrence(
  state: SynchronousIndexState,
  occurrence: GraphFunctionOccurrence,
): void {
  const ordinal = state.occurrences.length;
  state.occurrences.push(occurrence);
  state.occurrenceOrdinal.set(occurrence, ordinal);
  if (typeof occurrence.filePath === 'string') {
    state.catalogFiles.add(occurrence.filePath.replaceAll('\\', '/'));
  }
  addSynchronousReverseEdges(state, occurrence, ordinal);
}

function buildSynchronousImpactIndex(catalog: GraphCatalog): SynchronousImpactIndex {
  const state: SynchronousIndexState = {
    occurrences: [],
    occurrenceOrdinal: new Map(),
    reverse: new Map(),
    catalogFiles: new Set(),
    approximate: catalog.resolutionMode === 'fast',
  };
  for (const name in catalog.functions) {
    if (!Object.hasOwn(catalog.functions, name)) continue;
    const occurrences = catalog.functions[name];
    if (occurrences === undefined) continue;
    for (const occurrence of occurrences) addSynchronousOccurrence(state, occurrence);
  }
  return {
    occurrences: state.occurrences,
    occurrenceOrdinal: state.occurrenceOrdinal,
    reverseAdjacency: new Map(
      [...state.reverse].map(([bodyHash, callers]) => [bodyHash, [...callers]]),
    ),
    catalogFiles: state.catalogFiles,
    catalogApproximate: state.approximate,
  };
}

function collectSynchronousChangedOccurrences(
  index: SynchronousImpactIndex,
  changedFiles: ReadonlySet<string>,
  resultLimit: number | undefined,
): {
  readonly occurrences: readonly GraphFunctionOccurrence[];
  readonly truncated: boolean;
} {
  const occurrences: GraphFunctionOccurrence[] = [];
  for (const occurrence of index.occurrences) {
    if (
      typeof occurrence.filePath !== 'string' ||
      !changedFiles.has(occurrence.filePath.replaceAll('\\', '/'))
    ) {
      continue;
    }
    if (resultLimit !== undefined && occurrences.length >= resultLimit) {
      return { occurrences, truncated: true };
    }
    occurrences.push(occurrence);
  }
  return { occurrences, truncated: false };
}

interface SynchronousCallerQueueEntry {
  readonly ordinal: number;
  readonly depth: number;
}

interface SynchronousCallerTraversal {
  readonly index: SynchronousImpactIndex;
  readonly changedOrdinals: ReadonlySet<number>;
  readonly visited: Set<number>;
  readonly queue: SynchronousCallerQueueEntry[];
  readonly maxDepth: number;
  readonly resultLimit: number | undefined;
}

interface SynchronousCallerSeed {
  readonly bodyHash: string;
  readonly depth: number;
}

function enqueueSynchronousCallers(
  traversal: SynchronousCallerTraversal,
  seed: SynchronousCallerSeed,
): boolean {
  if (seed.depth > traversal.maxDepth) return false;
  for (const caller of traversal.index.reverseAdjacency.get(seed.bodyHash) ?? []) {
    if (traversal.changedOrdinals.has(caller) || traversal.visited.has(caller)) {
      continue;
    }
    if (traversal.resultLimit !== undefined && traversal.visited.size >= traversal.resultLimit) {
      return true;
    }
    traversal.visited.add(caller);
    traversal.queue.push({ ordinal: caller, depth: seed.depth });
  }
  return false;
}

function collectSynchronousImpactedOrdinals(
  index: SynchronousImpactIndex,
  changedOrdinals: ReadonlySet<number>,
  maxDepth: number,
  resultLimit: number | undefined,
): { readonly ordinals: readonly number[]; readonly truncated: boolean } {
  const traversal: SynchronousCallerTraversal = {
    index,
    changedOrdinals,
    visited: new Set<number>(),
    queue: [],
    maxDepth,
    resultLimit,
  };
  let truncated = false;
  for (const ordinal of changedOrdinals) {
    const occurrence = index.occurrences[ordinal];
    if (
      occurrence !== undefined &&
      typeof occurrence.bodyHash === 'string' &&
      enqueueSynchronousCallers(traversal, {
        bodyHash: occurrence.bodyHash,
        depth: 1,
      })
    ) {
      truncated = true;
      break;
    }
  }
  const ordinals: number[] = [];
  for (const current of traversal.queue) {
    const occurrence = index.occurrences[current.ordinal];
    if (occurrence === undefined) continue;
    ordinals.push(current.ordinal);
    if (
      !truncated &&
      typeof occurrence.bodyHash === 'string' &&
      enqueueSynchronousCallers(traversal, {
        bodyHash: occurrence.bodyHash,
        depth: current.depth + 1,
      })
    ) {
      truncated = true;
    }
  }
  return { ordinals, truncated };
}

function projectSynchronousChangedFunctions(
  index: SynchronousImpactIndex,
  occurrences: readonly GraphFunctionOccurrence[],
  catalog: GraphCatalog,
): {
  readonly functions: readonly ImpactFunction[];
  readonly ordinals: ReadonlySet<number>;
  readonly malformedRowOmitted: boolean;
} {
  const ordinals = new Set<number>();
  const functions: ImpactFunction[] = [];
  let malformedRowOmitted = false;
  for (const occurrence of occurrences) {
    const ordinal = index.occurrenceOrdinal.get(occurrence);
    if (ordinal !== undefined) ordinals.add(ordinal);
    const projected = toImpactFunction(occurrence, 'changed', catalog);
    if (projected === undefined) malformedRowOmitted = true;
    else functions.push(projected);
  }
  return { functions, ordinals, malformedRowOmitted };
}

function projectSynchronousImpactedFunctions(
  index: SynchronousImpactIndex,
  ordinals: readonly number[],
  catalog: GraphCatalog,
): {
  readonly functions: readonly ImpactFunction[];
  readonly malformedRowOmitted: boolean;
} {
  const functions: ImpactFunction[] = [];
  let malformedRowOmitted = false;
  for (const ordinal of ordinals) {
    const occurrence = index.occurrences[ordinal];
    if (occurrence === undefined) continue;
    const projected = toImpactFunction(
      occurrence,
      impactReason(catalog, occurrence.bodyHash),
      catalog,
    );
    if (projected === undefined) malformedRowOmitted = true;
    else functions.push(projected);
  }
  return { functions, malformedRowOmitted };
}

function buildSynchronousImpactedPackages(
  changedFunctions: readonly ImpactFunction[],
  impactedFunctions: readonly ImpactFunction[],
): ImpactPackage[] {
  const counts = new Map<string, number>();
  for (const functions of [changedFunctions, impactedFunctions]) {
    for (const fn of functions) {
      const packageName = fn.package ?? 'root';
      counts.set(packageName, (counts.get(packageName) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([name, functionCount]) => ({ name, functionCount }))
    .sort((left, right) =>
      right.functionCount === left.functionCount
        ? compareImpactText(left.name, right.name)
        : right.functionCount - left.functionCount,
    );
}

function buildSynchronousImpactedFiles(
  changedFunctions: readonly ImpactFunction[],
  impactedFunctions: readonly ImpactFunction[],
): string[] {
  const files = new Set<string>();
  for (const functions of [changedFunctions, impactedFunctions]) {
    for (const fn of functions) files.add(fn.filePath);
  }
  return [...files].sort(compareImpactText);
}

export function computeImpactSynchronousEngine(
  catalog: GraphCatalog,
  changedFiles: readonly string[],
  options?: ComputeImpactOptions,
): ImpactComputation {
  const index = buildSynchronousImpactIndex(catalog);
  const resultLimit = impactResultLimit(options?.top);
  const changedSet = new Set(changedFiles.map((file) => file.replaceAll('\\', '/')));
  const changed = collectSynchronousChangedOccurrences(index, changedSet, resultLimit);
  const changedProjection = projectSynchronousChangedFunctions(index, changed.occurrences, catalog);
  const traversal = collectSynchronousImpactedOrdinals(
    index,
    changedProjection.ordinals,
    options?.maxDepth ?? DEFAULT_MAX_DEPTH,
    remainingImpactLimit(resultLimit, changed.occurrences.length),
  );
  const impactedProjection = projectSynchronousImpactedFunctions(
    index,
    traversal.ordinals,
    catalog,
  );
  const truncated = changed.truncated || traversal.truncated;
  const malformedRowOmitted =
    changedProjection.malformedRowOmitted || impactedProjection.malformedRowOmitted;
  return {
    changedFunctions: changedProjection.functions,
    impactedFunctions: impactedProjection.functions,
    impactedPackages: buildSynchronousImpactedPackages(
      changedProjection.functions,
      impactedProjection.functions,
    ),
    impactedFiles: buildSynchronousImpactedFiles(
      changedProjection.functions,
      impactedProjection.functions,
    ),
    trust: buildImpactTrust({
      uncertainties: mergeImpactUncertainties(
        options?.uncertainties,
        catalogUncertainties(catalog, index),
        changedFileEntryUncertainties(index, changedFiles, options?.changedFileEntries),
        malformedImpactUncertainty(malformedRowOmitted),
        truncatedImpactUncertainty(truncated),
      ),
    }),
    truncated,
  };
}
