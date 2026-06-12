/**
 * Leaf partition-chunk primitives shared by the flat-monorepo strategies
 * (`flat-monorepo-strategy.ts`) and the community partitioner
 * (`community-partition.ts`, ADR-0045).
 *
 * Hoisted out of `flat-monorepo-strategy.ts` so `community-partition.ts`
 * can reuse `chunkByCount` without a module cycle
 * (`flat-monorepo-strategy → community-partition → partition-chunk`).
 * Behavior-preserving move — `flat-monorepo-strategy.test.ts` is the
 * refactor canary.
 */

/**
 * Synthetic partition — the unit that gets handed to a child process in
 * the flat-large fan-out. `id` is suitable as a display label and a
 * cache-key segment; `files` are absolute paths.
 */
export interface SyntheticPartition {
  readonly id: string;
  readonly files: readonly string[];
}

/**
 * Default chunk size for `file-count-chunks` and `hybrid` sub-partitioning
 * (and the community strategy's max shard size). Chosen at 2000 to stay
 * well below the 2500-file heap-elevation threshold — each partition runs
 * in a child process with a default V8 heap (no elevation needed at this
 * size).
 */
export const DEFAULT_CHUNK_SIZE = 2000;

/**
 * Sort `files` lexicographically (stable) and split into chunks of
 * `chunkSize`. Partition ids follow the `chunk-N` contract (`chunk-0`,
 * `chunk-1`, …) that `hybrid` sub-partition ids and the community
 * strategy's split ids (`<parent>.chunk-N`) concatenate onto — the id
 * scheme is load-bearing for fragment-cache keys, so it must not drift.
 */
export function chunkByCount(
  files: readonly string[],
  chunkSize: number,
): readonly SyntheticPartition[] {
  const sorted = [...files].sort();
  const out: SyntheticPartition[] = [];
  for (let i = 0; i < sorted.length; i += chunkSize) {
    out.push({
      id: `chunk-${String(out.length)}`,
      files: sorted.slice(i, i + chunkSize),
    });
  }
  return out;
}
