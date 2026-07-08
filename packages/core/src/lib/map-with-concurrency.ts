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
  const results: ({ readonly value: R } | undefined)[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
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
    if (entry === undefined) throw new Error('mapWithConcurrency worker did not fill result slot');
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
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
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