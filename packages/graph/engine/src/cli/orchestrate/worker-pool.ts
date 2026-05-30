/**
 * A tiny fixed-size worker pool — the concurrency primitive shared by the
 * shard runner and the legacy `--workspace` fan-out.
 *
 * Each of `concurrency` slots pulls the next item off a shared queue, runs
 * `run(item)`, and repeats until the queue is empty. The cap bounds how
 * many child processes run at once (memory/oversubscription control); the
 * total number of items is unbounded.
 *
 * Results are returned in COMPLETION order, not input order — callers that
 * need determinism sort afterward (shards sort by shardId).
 */
export async function runWorkerPool<I, O>(
  items: readonly I[],
  concurrency: number,
  run: (item: I) => Promise<O>,
): Promise<O[]> {
  const queue = [...items];
  const results: O[] = [];
  const slots = Math.max(1, concurrency);

  async function worker(): Promise<void> {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      results.push(await run(item));
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < slots; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
