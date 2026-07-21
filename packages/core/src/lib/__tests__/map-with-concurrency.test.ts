import { describe, expect, it } from 'vitest';

import { forEachWithConcurrency, mapWithConcurrency } from '../map-with-concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves order with bounded concurrency', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, (item, index) =>
      Promise.resolve(item + index),
    );
    expect(out).toEqual([1, 3, 5, 7]);
  });

  it('M2: concurrency <= 0 still processes items (does not hang with 0 workers)', async () => {
    const out = await mapWithConcurrency([10, 20], 0, (item) => Promise.resolve(item * 2));
    expect(out).toEqual([20, 40]);
    const outNeg = await mapWithConcurrency([1], -3, (item) => Promise.resolve(item + 1));
    expect(outNeg).toEqual([2]);
  });

  it('returns [] for empty input without invoking workers', async () => {
    const out = await mapWithConcurrency([], 0, () => Promise.resolve(1));
    expect(out).toEqual([]);
  });
});

describe('forEachWithConcurrency', () => {
  it('visits every item', async () => {
    const seen: number[] = [];
    await forEachWithConcurrency([1, 2, 3], 2, (item) => {
      seen.push(item);
      return Promise.resolve();
    });
    const sorted = [...seen];
    sorted.sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3]);
  });

  it('M2: concurrency 0 still visits every item', async () => {
    const seen: number[] = [];
    await forEachWithConcurrency([1, 2], 0, (item) => {
      seen.push(item);
      return Promise.resolve();
    });
    expect(seen.toSorted((a, b) => a - b)).toEqual([1, 2]);
  });
});
