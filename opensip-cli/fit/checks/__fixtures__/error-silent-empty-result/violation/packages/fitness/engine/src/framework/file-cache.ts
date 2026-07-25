/**
 * VIOLATION fixture (R2) — reduced from the REAL confirmed site
 * `packages/fitness/engine/src/framework/file-cache.ts` (`FileCache.prewarm`).
 *
 * The batch is settled, then only `status === 'fulfilled'` entries are kept.
 * Every rejected read (EACCES, EMFILE, ENOENT race, EISDIR) is dropped with no
 * count, no reason and no diagnostic — and `filesLoaded` is then reported as
 * though it were the whole batch.
 *
 * Expected: ONE `error-silent-empty-result` finding on the `Promise.allSettled`.
 */
import * as fs from 'node:fs/promises';

const PREWARM_BATCH_SIZE = 100;

export async function prewarm(files: readonly string[]): Promise<{ filesLoaded: number }> {
  const cache = new Map<string, string>();

  for (let i = 0; i < files.length; i += PREWARM_BATCH_SIZE) {
    const batch = files.slice(i, i + PREWARM_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (filePath) => ({ filePath, content: await fs.readFile(filePath, 'utf8') })),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        cache.set(result.value.filePath, result.value.content);
      }
    }
  }

  return { filesLoaded: cache.size };
}
