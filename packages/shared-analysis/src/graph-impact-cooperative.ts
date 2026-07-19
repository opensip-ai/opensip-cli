import { ComputeImpactCancelledError } from '@opensip-cli/contracts';

export const ASYNC_BATCH_SIZE = 512;

/** @throws {ComputeImpactCancelledError} When cooperative work has been cancelled. */
export function assertImpactNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ComputeImpactCancelledError();
}

export async function yieldImpactWork(signal: AbortSignal | undefined): Promise<void> {
  assertImpactNotCancelled(signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assertImpactNotCancelled(signal);
}

async function mergeSortedRuns<T>(
  left: readonly T[],
  right: readonly T[],
  compare: (left: T, right: T) => number,
  signal: AbortSignal | undefined,
  work: { value: number },
): Promise<T[]> {
  const merged: T[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    assertImpactNotCancelled(signal);
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    if (
      rightValue === undefined ||
      (leftValue !== undefined && compare(leftValue, rightValue) <= 0)
    ) {
      if (leftValue !== undefined) merged.push(leftValue);
      leftIndex++;
    } else {
      merged.push(rightValue);
      rightIndex++;
    }
    work.value++;
    if (work.value % ASYNC_BATCH_SIZE === 0) await yieldImpactWork(signal);
  }
  return merged;
}

export async function sortInBoundedBatches<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
  signal: AbortSignal | undefined,
): Promise<T[]> {
  if (values.length <= 1) return [...values];
  let runs: T[][] = [];
  for (let offset = 0; offset < values.length; offset += ASYNC_BATCH_SIZE) {
    assertImpactNotCancelled(signal);
    runs.push(values.slice(offset, offset + ASYNC_BATCH_SIZE).sort(compare));
    await yieldImpactWork(signal);
  }
  const work = { value: 0 };
  while (runs.length > 1) {
    const next: T[][] = [];
    for (let runIndex = 0; runIndex < runs.length; runIndex += 2) {
      const left = runs[runIndex] ?? [];
      const right = runs[runIndex + 1];
      next.push(
        right === undefined ? left : await mergeSortedRuns(left, right, compare, signal, work),
      );
    }
    runs = next;
  }
  return runs[0] ?? [];
}
