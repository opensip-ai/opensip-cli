import { createHash } from 'node:crypto';

import {
  ASYNC_BATCH_SIZE,
  assertImpactNotCancelled,
  yieldImpactWork,
} from './graph-impact-cooperative.js';

import type {
  ComputeImpactIndex,
  GraphCatalog,
  GraphFunctionOccurrence,
} from '@opensip-cli/contracts';

interface ReverseEdgesForOccurrenceInput {
  readonly reverse: Map<string, Set<number>>;
  readonly occurrence: GraphFunctionOccurrence;
  readonly ordinal: number;
  readonly work: { value: number };
  readonly approximate: { value: boolean };
  readonly signal: AbortSignal | undefined;
}

// @sequential-ok -- Hashing and adjacency construction mutate shared bounded state;
// concurrency would reorder the generation identity and cooperative checkpoints.
async function addReverseEdgesForOccurrence(input: ReverseEdgesForOccurrenceInput): Promise<void> {
  const { reverse, occurrence, ordinal, work, approximate, signal } = input;
  for (const edge of occurrence.calls) {
    if (edge.confidence !== 'high' || edge.resolution === 'syntactic') approximate.value = true;
    for (const calleeHash of edge.to) {
      assertImpactNotCancelled(signal);
      const callers = reverse.get(calleeHash) ?? new Set<number>();
      callers.add(ordinal);
      reverse.set(calleeHash, callers);
      work.value++;
      if (work.value % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
    }
  }
}

async function buildReverseAdjacency(
  occurrences: readonly GraphFunctionOccurrence[],
  approximate: { value: boolean },
  signal: AbortSignal | undefined,
): Promise<Map<string, readonly number[]>> {
  const reverse = new Map<string, Set<number>>();
  const work = { value: 0 };
  for (const [ordinal, occurrence] of occurrences.entries()) {
    assertImpactNotCancelled(signal);
    // @fitness-ignore-next-line async-waterfall-detection -- The shared reverse map and work counter must be updated before the cooperative checkpoint.
    await addReverseEdgesForOccurrence({ reverse, occurrence, ordinal, work, approximate, signal });
    work.value++;
    if (work.value % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
  }
  const result = new Map<string, readonly number[]>();
  for (const [hash, callers] of reverse) {
    const ordinals: number[] = [];
    for (const caller of callers) {
      assertImpactNotCancelled(signal);
      ordinals.push(caller);
      work.value++;
      if (work.value % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
    }
    result.set(hash, ordinals);
  }
  return result;
}

type ImpactIdentityRecord = (value: unknown) => void;

async function updateOccurrenceIdentity(
  occurrence: GraphFunctionOccurrence,
  recordIdentity: ImpactIdentityRecord,
  work: { value: number },
  signal: AbortSignal | undefined,
): Promise<void> {
  recordIdentity([
    occurrence.bodyHash,
    occurrence.qualifiedName,
    occurrence.filePath.replaceAll('\\', '/'),
    occurrence.package ?? null,
    occurrence.line,
  ]);
  recordIdentity(occurrence.calls.length);
  for (const edge of occurrence.calls) {
    assertImpactNotCancelled(signal);
    recordIdentity([edge.to.length, edge.resolution, edge.confidence]);
    for (const target of edge.to) {
      recordIdentity(target);
      work.value++;
      if (work.value % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
    }
    work.value++;
    if (work.value % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
  }
}

function impactIdentityUpdater(): {
  readonly record: ImpactIdentityRecord;
  readonly digest: () => string;
} {
  const hash = createHash('sha256');
  return {
    record: (value: unknown): void => {
      const encoded = JSON.stringify(value);
      const text = encoded ?? 'undefined';
      hash.update(String(Buffer.byteLength(text, 'utf8')));
      hash.update(':');
      hash.update(text, 'utf8');
      hash.update(';');
    },
    digest: () => hash.digest('hex'),
  };
}

export async function computeImpactCatalogGenerationIdentity(
  catalog: GraphCatalog,
  signal?: AbortSignal,
): Promise<string> {
  const identity = impactIdentityUpdater();
  const { record } = identity;
  record([
    catalog.version,
    catalog.tool,
    catalog.language,
    catalog.builtAt,
    catalog.cacheKey ?? null,
    catalog.filesFingerprint ?? null,
    catalog.resolutionMode ?? 'exact',
  ]);
  const work = { value: 0 };
  for (const group in catalog.functions) {
    if (!Object.hasOwn(catalog.functions, group)) continue;
    assertImpactNotCancelled(signal);
    const occurrences = catalog.functions[group];
    if (occurrences === undefined) continue;
    record(group);
    record(occurrences.length);
    for (const occurrence of occurrences) {
      assertImpactNotCancelled(signal);
      // @fitness-ignore-next-line async-waterfall-detection -- Identity bytes and the shared work counter must advance in catalog order before yielding.
      await updateOccurrenceIdentity(occurrence, record, work, signal);
      work.value++;
      if (work.value % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
    }
  }
  assertImpactNotCancelled(signal);
  return `impact-v2:${identity.digest()}`;
}

export async function computeImpactIndexMatchesCatalog(
  index: ComputeImpactIndex,
  catalog: GraphCatalog,
  signal?: AbortSignal,
): Promise<boolean> {
  if (index.sourceCatalog === catalog) return true;
  return (
    index.catalogGenerationIdentity ===
    (await computeImpactCatalogGenerationIdentity(catalog, signal))
  );
}

export async function buildComputeImpactIndex(
  catalog: GraphCatalog,
  signal?: AbortSignal,
): Promise<ComputeImpactIndex> {
  assertImpactNotCancelled(signal);
  const occurrences: GraphFunctionOccurrence[] = [];
  const occurrencesByFile = new Map<string, GraphFunctionOccurrence[]>();
  const occurrenceOrdinal = new Map<GraphFunctionOccurrence, number>();
  const catalogFiles = new Set<string>();
  let work = 0;
  const catalogApproximate = { value: catalog.resolutionMode === 'fast' };
  for (const name in catalog.functions) {
    if (!Object.hasOwn(catalog.functions, name)) continue;
    const group = catalog.functions[name];
    if (group === undefined) continue;
    for (const occurrence of group) {
      assertImpactNotCancelled(signal);
      const ordinal = occurrences.length;
      occurrences.push(occurrence);
      const filePath = occurrence.filePath.replaceAll('\\', '/');
      const bucket = occurrencesByFile.get(filePath) ?? [];
      bucket.push(occurrence);
      occurrencesByFile.set(filePath, bucket);
      catalogFiles.add(filePath);
      occurrenceOrdinal.set(occurrence, ordinal);
      work++;
      if (work % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
    }
  }
  const [catalogGenerationIdentity, reverseAdjacency] = await Promise.all([
    computeImpactCatalogGenerationIdentity(catalog, signal),
    buildReverseAdjacency(occurrences, catalogApproximate, signal),
  ]);
  return {
    sourceCatalog: catalog,
    catalogGenerationIdentity,
    occurrences,
    occurrencesByFile,
    occurrenceOrdinal,
    reverseAdjacency,
    catalogFiles,
    catalogApproximate: catalogApproximate.value,
  };
}
