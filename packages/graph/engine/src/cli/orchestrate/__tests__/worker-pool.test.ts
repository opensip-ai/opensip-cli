/**
 * The shared bounded worker pool — runs every item, never exceeds the
 * concurrency cap, and tolerates a slot count larger than the item count.
 */

import { describe, expect, it } from 'vitest';

import { runWorkerPool } from '../worker-pool.js';

describe('runWorkerPool', () => {
  it('runs every item exactly once', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runWorkerPool(items, 2, (n) => Promise.resolve(n * 10));
    expect([...results].sort((a: number, b: number) => a - b)).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency cap', async () => {
    let active = 0;
    let peak = 0;
    const run = async (n: number): Promise<number> => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    };
    await runWorkerPool([1, 2, 3, 4, 5, 6, 7, 8], 3, run);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('clamps a zero/negative cap to at least one slot and still completes', async () => {
    const results = await runWorkerPool([1, 2, 3], 0, (n) => Promise.resolve(n));
    expect([...results].sort((a: number, b: number) => a - b)).toEqual([1, 2, 3]);
  });

  it('handles an empty item list', async () => {
    expect(await runWorkerPool([], 4, () => Promise.resolve(1))).toEqual([]);
  });

  it('throws on non-finite concurrency (NaN, Infinity) rather than producing zero workers', async () => {
    await expect(runWorkerPool([1], NaN, (n) => Promise.resolve(n))).rejects.toThrow(
      /concurrency must be a finite number/,
    );
    await expect(runWorkerPool([1], Infinity, (n) => Promise.resolve(n))).rejects.toThrow(
      /concurrency must be a finite number/,
    );
  });
});
