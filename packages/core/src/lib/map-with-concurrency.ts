import { executionInvariantError } from './execution-invariant-error.js';

/**
 * Bounded-concurrency helpers for ordered maps and side-effect fan-out.
 */

/**
 * Map `items` with a bounded worker pool, preserving input order in the result.
 *
 * @throws {Error} When a worker fails to fill a result slot (internal invariant violation).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  // M2: concurrency <= 0 used to spawn 0 workers and hang on empty Promise.all
  // while results stayed undefined. Floor at 1 for non-empty inputs.
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  const results: ({ readonly value: R } | undefined)[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex++;
      if (index >= items.length) return;
      results[index] = { value: await fn(items[index], index) };
    }
  });

  await Promise.all(workers);
  const ordered: R[] = [];
  for (let index = 0; index < items.length; index++) {
    const entry = results[index];
    if (entry === undefined)
      throw executionInvariantError(
        'map-concurrency-empty-slot',
        'mapWithConcurrency worker did not fill result slot',
      );
    ordered.push(entry.value);
  }
  return ordered;
}

/** Invoke `fn` for each item with bounded concurrency. */
export async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  // M2: same floor as mapWithConcurrency — never spawn zero workers.
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  let nextIndex = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      await fn(item);
    }
  });

  await Promise.all(workers);
}
