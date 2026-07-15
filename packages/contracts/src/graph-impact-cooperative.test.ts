import { describe, expect, it } from 'vitest';

import {
  ASYNC_BATCH_SIZE,
  assertImpactNotCancelled,
  sortInBoundedBatches,
  yieldImpactWork,
} from './graph-impact-cooperative.js';
import { ComputeImpactCancelledError } from './graph-impact-model.js';

const compareNumber = (left: number, right: number): number => left - right;
const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

describe('assertImpactNotCancelled / yieldImpactWork', () => {
  it('accepts an absent or live signal', async () => {
    expect(() => assertImpactNotCancelled(undefined)).not.toThrow();
    expect(() => assertImpactNotCancelled(new AbortController().signal)).not.toThrow();
    await expect(yieldImpactWork(undefined)).resolves.toBeUndefined();
    await expect(yieldImpactWork(new AbortController().signal)).resolves.toBeUndefined();
  });

  it('throws ComputeImpactCancelledError when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => assertImpactNotCancelled(controller.signal)).toThrow(ComputeImpactCancelledError);
    await expect(yieldImpactWork(controller.signal)).rejects.toBeInstanceOf(
      ComputeImpactCancelledError,
    );
  });

  it('throws when cancellation lands during the yield turn', async () => {
    const controller = new AbortController();
    const pending = yieldImpactWork(controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ComputeImpactCancelledError);
  });
});

describe('sortInBoundedBatches', () => {
  it('returns a copy for empty and single-element inputs without sorting', async () => {
    const empty = await sortInBoundedBatches([], compareNumber, undefined);
    expect(empty).toEqual([]);
    expect(empty).not.toBe([]);

    const single = [7];
    const sorted = await sortInBoundedBatches(single, compareNumber, undefined);
    expect(sorted).toEqual([7]);
    expect(sorted).not.toBe(single);
  });

  it('sorts a small in-batch array stably by compare', async () => {
    const values = [3, 1, 4, 1, 5, 9, 2, 6];
    await expect(sortInBoundedBatches(values, compareNumber, undefined)).resolves.toEqual([
      1, 1, 2, 3, 4, 5, 6, 9,
    ]);
  });

  it('sorts multi-batch inputs that force mergeSortedRuns (> ASYNC_BATCH_SIZE)', async () => {
    expect(ASYNC_BATCH_SIZE).toBe(512);
    // Two full batches + remainder so the multi-run merge tree runs at least once.
    const length = ASYNC_BATCH_SIZE * 2 + 17;
    const values = Array.from({ length }, (_, index) => length - index);
    const sorted = await sortInBoundedBatches(values, compareNumber, undefined);
    expect(sorted).toHaveLength(length);
    expect(sorted[0]).toBe(1);
    expect(sorted.at(-1)).toBe(length);
    for (let index = 1; index < sorted.length; index++) {
      expect(sorted[index]! >= sorted[index - 1]!).toBe(true);
    }
  });

  it('carries an odd leftover run through the merge tree without dropping it', async () => {
    // Three runs (batch, batch, singleton) so one merge pass keeps the unpaired left run.
    const length = ASYNC_BATCH_SIZE * 2 + 1;
    const values = Array.from({ length }, (_, index) => (index % 2 === 0 ? index : -index));
    const sorted = await sortInBoundedBatches(values, compareNumber, undefined);
    expect(sorted).toHaveLength(length);
    const expected = [...values].sort(compareNumber);
    expect(sorted).toEqual(expected);
  });

  it('merges when the right run is entirely greater (left-exhaust path)', async () => {
    // First batch all small, second batch all large — merge always prefers left until empty.
    const leftBatch = Array.from({ length: ASYNC_BATCH_SIZE }, (_, index) => index);
    const rightBatch = Array.from(
      { length: ASYNC_BATCH_SIZE },
      (_, index) => ASYNC_BATCH_SIZE + index,
    );
    const values = [...leftBatch, ...rightBatch];
    await expect(sortInBoundedBatches(values, compareNumber, undefined)).resolves.toEqual(
      Array.from({ length: ASYNC_BATCH_SIZE * 2 }, (_, index) => index),
    );
  });

  it('merges when the left run is entirely greater (right-prefer path)', async () => {
    // First batch all large, second batch all small — merge drains right first.
    const leftBatch = Array.from(
      { length: ASYNC_BATCH_SIZE },
      (_, index) => ASYNC_BATCH_SIZE + index,
    );
    const rightBatch = Array.from({ length: ASYNC_BATCH_SIZE }, (_, index) => index);
    const values = [...leftBatch, ...rightBatch];
    await expect(sortInBoundedBatches(values, compareNumber, undefined)).resolves.toEqual(
      Array.from({ length: ASYNC_BATCH_SIZE * 2 }, (_, index) => index),
    );
  });

  it('yields and continues during a long merge that crosses ASYNC_BATCH_SIZE work units', async () => {
    // Two large reverse-sorted halves force ~1024 compare/push steps in one merge.
    const length = ASYNC_BATCH_SIZE * 2;
    const values = Array.from({ length }, (_, index) => length - index);
    const sorted = await sortInBoundedBatches(values, compareNumber, undefined);
    expect(sorted).toEqual(Array.from({ length }, (_, index) => index + 1));
  });

  it('sorts strings with a custom comparator across batch boundaries', async () => {
    const values = Array.from(
      { length: ASYNC_BATCH_SIZE + 3 },
      (_, index) => `item-${String(ASYNC_BATCH_SIZE + 3 - index).padStart(4, '0')}`,
    );
    const sorted = await sortInBoundedBatches(values, compareString, undefined);
    expect(sorted[0]).toBe('item-0001');
    expect(sorted.at(-1)).toBe(`item-${String(ASYNC_BATCH_SIZE + 3).padStart(4, '0')}`);
  });

  it('rejects when the signal is already aborted before sorting', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      sortInBoundedBatches([2, 1], compareNumber, controller.signal),
    ).rejects.toBeInstanceOf(ComputeImpactCancelledError);
  });

  it('rejects when aborted during multi-batch sort construction', async () => {
    const controller = new AbortController();
    const values = Array.from({ length: ASYNC_BATCH_SIZE * 3 }, (_, index) => index);
    const pending = sortInBoundedBatches(values, compareNumber, controller.signal);
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toBeInstanceOf(ComputeImpactCancelledError);
  });

  it('rejects when aborted during a long multi-run merge', async () => {
    const controller = new AbortController();
    // Four batches guarantee multiple merge levels and many cooperative yields.
    const values = Array.from({ length: ASYNC_BATCH_SIZE * 4 }, (_, index) => -index);
    const pending = sortInBoundedBatches(values, compareNumber, controller.signal);
    // Let the first batch sort start, then cancel mid-merge.
    await Promise.resolve();
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toBeInstanceOf(ComputeImpactCancelledError);
  });
});
