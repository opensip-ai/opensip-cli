import {
  buildImpactTrust,
  ComputeImpactIndexGenerationMismatchError,
  mergeImpactUncertainties,
} from '@opensip-cli/contracts';

import {
  ASYNC_BATCH_SIZE,
  assertImpactNotCancelled,
  sortInBoundedBatches,
  yieldImpactWork,
} from './graph-impact-cooperative.js';
import { buildComputeImpactIndex, computeImpactIndexMatchesCatalog } from './graph-impact-index.js';
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

import type {
  ComputeImpactAsyncOptions,
  ComputeImpactIndex,
  GraphCatalog,
  GraphFunctionOccurrence,
  ImpactComputation,
  ImpactFunction,
  ImpactPackage,
} from '@opensip-cli/contracts';

interface CallerBfsContext {
  readonly occurrences: readonly GraphFunctionOccurrence[];
  readonly reverse: ReadonlyMap<string, readonly number[]>;
  readonly changedOrdinals: ReadonlySet<number>;
  readonly visited: Set<number>;
  readonly queue: { readonly ordinal: number; readonly depth: number }[];
  readonly resultLimit: number | undefined;
}

async function enqueueUnvisitedCallers(
  context: CallerBfsContext,
  bodyHash: string,
  depth: number,
  maxDepth: number,
  work: { value: number },
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (depth > maxDepth) return false;
  for (const caller of context.reverse.get(bodyHash) ?? []) {
    assertImpactNotCancelled(signal);
    if (context.changedOrdinals.has(caller) || context.visited.has(caller)) continue;
    if (context.resultLimit !== undefined && context.visited.size >= context.resultLimit)
      return true;
    context.visited.add(caller);
    context.queue.push({ ordinal: caller, depth });
    work.value++;
    if (work.value % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
  }
  return false;
}

async function collectImpactedOccurrenceOrdinals(
  index: ComputeImpactIndex,
  changedOrdinals: ReadonlySet<number>,
  maxDepth: number,
  resultLimit: number | undefined,
  signal?: AbortSignal,
): Promise<{
  readonly ordinals: readonly number[];
  readonly truncated: boolean;
}> {
  const context: CallerBfsContext = {
    occurrences: index.occurrences,
    reverse: index.reverseAdjacency,
    changedOrdinals,
    visited: new Set<number>(),
    queue: [],
    resultLimit,
  };
  const impactedOrdinals: number[] = [];
  let truncated = false;
  const work = { value: 0 };
  for (const ordinal of changedOrdinals) {
    assertImpactNotCancelled(signal);
    const occurrence = index.occurrences[ordinal];
    if (
      occurrence !== undefined &&
      (await enqueueUnvisitedCallers(context, occurrence.bodyHash, 1, maxDepth, work, signal))
    ) {
      truncated = true;
      break;
    }
  }
  let cursor = 0;
  while (cursor < context.queue.length) {
    assertImpactNotCancelled(signal);
    const current = context.queue[cursor++];
    if (current === undefined) continue;
    const occurrence = context.occurrences[current.ordinal];
    if (occurrence === undefined) continue;
    impactedOrdinals.push(current.ordinal);
    if (
      !truncated &&
      (await enqueueUnvisitedCallers(
        context,
        occurrence.bodyHash,
        current.depth + 1,
        maxDepth,
        work,
        signal,
      ))
    ) {
      truncated = true;
    }
    work.value++;
    if (work.value % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
  }
  return { ordinals: impactedOrdinals, truncated };
}

async function buildImpactedPackages(
  changedFunctions: readonly ImpactFunction[],
  impactedFunctions: readonly ImpactFunction[],
  signal: AbortSignal | undefined,
): Promise<ImpactPackage[]> {
  const packageCounts = new Map<string, number>();
  let work = 0;
  for (const functions of [changedFunctions, impactedFunctions]) {
    for (const fn of functions) {
      assertImpactNotCancelled(signal);
      const packageName = fn.package ?? 'root';
      packageCounts.set(packageName, (packageCounts.get(packageName) ?? 0) + 1);
      work++;
      if (work % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
    }
  }
  const packages: ImpactPackage[] = [];
  for (const [name, functionCount] of packageCounts) {
    assertImpactNotCancelled(signal);
    packages.push({ name, functionCount });
    work++;
    if (work % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
  }
  return sortInBoundedBatches(
    packages,
    (left, right) =>
      right.functionCount - left.functionCount || compareImpactText(left.name, right.name),
    signal,
  );
}

async function buildImpactedFiles(
  changedFunctions: readonly ImpactFunction[],
  impactedFunctions: readonly ImpactFunction[],
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const fileSet = new Set<string>();
  let work = 0;
  for (const functions of [changedFunctions, impactedFunctions]) {
    for (const fn of functions) {
      assertImpactNotCancelled(signal);
      fileSet.add(fn.filePath);
      work++;
      if (work % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
    }
  }
  const files: string[] = [];
  for (const file of fileSet) {
    assertImpactNotCancelled(signal);
    files.push(file);
    work++;
    if (work % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
  }
  return sortInBoundedBatches(files, compareImpactText, signal);
}

async function collectChangedOccurrences(
  index: ComputeImpactIndex,
  changedFiles: ReadonlySet<string>,
  resultLimit: number | undefined,
  signal: AbortSignal | undefined,
): Promise<{
  readonly occurrences: readonly GraphFunctionOccurrence[];
  readonly truncated: boolean;
}> {
  const occurrences: GraphFunctionOccurrence[] = [];
  let work = 0;
  for (const occurrence of index.occurrences) {
    assertImpactNotCancelled(signal);
    work++;
    if (work % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
    if (!changedFiles.has(occurrence.filePath.replaceAll('\\', '/'))) continue;
    if (resultLimit !== undefined && occurrences.length >= resultLimit) {
      return { occurrences, truncated: true };
    }
    occurrences.push(occurrence);
  }
  return { occurrences, truncated: false };
}

async function projectChangedFunctions(
  index: ComputeImpactIndex,
  occurrences: readonly GraphFunctionOccurrence[],
  catalog: GraphCatalog,
  signal: AbortSignal | undefined,
): Promise<{
  readonly functions: readonly ImpactFunction[];
  readonly ordinals: ReadonlySet<number>;
  readonly malformedRowOmitted: boolean;
}> {
  const ordinals = new Set<number>();
  const functions: ImpactFunction[] = [];
  let malformedRowOmitted = false;
  let work = 0;
  for (const occurrence of occurrences) {
    assertImpactNotCancelled(signal);
    const ordinal = index.occurrenceOrdinal.get(occurrence);
    if (ordinal !== undefined) ordinals.add(ordinal);
    const projected = toImpactFunction(occurrence, 'changed', catalog);
    if (projected === undefined) malformedRowOmitted = true;
    else functions.push(projected);
    work++;
    if (work % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
  }
  return { functions, ordinals, malformedRowOmitted };
}

async function projectImpactedFunctions(
  index: ComputeImpactIndex,
  ordinals: readonly number[],
  catalog: GraphCatalog,
  signal: AbortSignal | undefined,
): Promise<{
  readonly functions: readonly ImpactFunction[];
  readonly malformedRowOmitted: boolean;
}> {
  const functions: ImpactFunction[] = [];
  let malformedRowOmitted = false;
  let work = 0;
  for (const ordinal of ordinals) {
    assertImpactNotCancelled(signal);
    const occurrence = index.occurrences[ordinal];
    if (occurrence !== undefined) {
      const projected = toImpactFunction(
        occurrence,
        impactReason(catalog, occurrence.bodyHash),
        catalog,
      );
      if (projected === undefined) malformedRowOmitted = true;
      else functions.push(projected);
    }
    work++;
    if (work % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
  }
  return { functions, malformedRowOmitted };
}

/**
 * Compute changed functions and their reverse-call closure cooperatively.
 *
 * @throws {ComputeImpactCancelledError} When the caller aborts cooperative work.
 * @throws {ComputeImpactIndexGenerationMismatchError} When a supplied index belongs to another catalog generation.
 */
export async function computeImpactAsync(
  catalog: GraphCatalog,
  changedFiles: readonly string[],
  options?: ComputeImpactAsyncOptions,
): Promise<ImpactComputation> {
  assertImpactNotCancelled(options?.signal);
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const index = options?.index ?? (await buildComputeImpactIndex(catalog, options?.signal));
  if (
    options?.index !== undefined &&
    !(await computeImpactIndexMatchesCatalog(index, catalog, options?.signal))
  ) {
    throw new ComputeImpactIndexGenerationMismatchError();
  }
  const resultLimit = impactResultLimit(options?.top);
  const changedSet = new Set(changedFiles.map((file) => file.replaceAll('\\', '/')));
  const changed = await collectChangedOccurrences(index, changedSet, resultLimit, options?.signal);
  const changedProjection = await projectChangedFunctions(
    index,
    changed.occurrences,
    catalog,
    options?.signal,
  );
  const traversal = await collectImpactedOccurrenceOrdinals(
    index,
    changedProjection.ordinals,
    maxDepth,
    remainingImpactLimit(resultLimit, changed.occurrences.length),
    options?.signal,
  );
  const impactedProjection = await projectImpactedFunctions(
    index,
    traversal.ordinals,
    catalog,
    options?.signal,
  );
  const changedFunctions = changedProjection.functions;
  const impactedFunctions = impactedProjection.functions;
  const impactedPackages = await buildImpactedPackages(
    changedFunctions,
    impactedFunctions,
    options?.signal,
  );
  const impactedFiles = await buildImpactedFiles(
    changedFunctions,
    impactedFunctions,
    options?.signal,
  );
  const truncated = changed.truncated || traversal.truncated;
  const trust = buildImpactTrust({
    uncertainties: mergeImpactUncertainties(
      options?.uncertainties,
      catalogUncertainties(catalog, index),
      changedFileEntryUncertainties(index, changedFiles, options?.changedFileEntries),
      malformedImpactUncertainty(
        changedProjection.malformedRowOmitted || impactedProjection.malformedRowOmitted,
      ),
      truncatedImpactUncertainty(truncated),
    ),
  });
  return {
    changedFunctions,
    impactedFunctions,
    impactedPackages,
    impactedFiles,
    trust,
    truncated,
  };
}
