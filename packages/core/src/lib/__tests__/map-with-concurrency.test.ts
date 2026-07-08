import { describe, expect, it } from 'vitest';

import { forEachWithConcurrency, mapWithConcurrency } from '../map-with-concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves order with bounded concurrency', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, (item, index) =>
      Promise.resolve(item + index),
    );
    expect(out).toEqual([1, 3, 5, 7]);
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
});
