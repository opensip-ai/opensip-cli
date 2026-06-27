import { describe, expect, it, vi } from 'vitest';

import { CheckAbortedError } from '../../framework/execution-context.js';
import { executeWithRetry } from '../retry.js';

const opts = (overrides: Partial<Parameters<typeof executeWithRetry>[1]> = {}) => ({
  enabled: true,
  maxRetries: 2,
  checkId: 'check-id',
  checkSlug: 'check-slug',
  ...overrides,
});

describe('executeWithRetry', () => {
  it('returns result on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const out = await executeWithRetry(fn, opts());
    expect(out).toEqual({
      result: 42,
      lastError: undefined,
      retryCount: 0,
      wasRetried: false,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry CheckAbortedError', async () => {
    const aborted = new CheckAbortedError('check-slug');
    const fn = vi.fn().mockRejectedValue(aborted);
    const out = await executeWithRetry(fn, opts());
    expect(out.wasRetried).toBe(false);
    expect(out.retryCount).toBe(0);
    expect(out.lastError).toBe(aborted);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry when retries are disabled', async () => {
    const err = new Error('boom');
    const fn = vi.fn().mockRejectedValue(err);
    const out = await executeWithRetry(fn, opts({ enabled: false }));
    expect(out.wasRetried).toBe(false);
    expect(out.retryCount).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry when maxRetries is 0', async () => {
    const err = new Error('boom');
    const fn = vi.fn().mockRejectedValue(err);
    const out = await executeWithRetry(fn, opts({ maxRetries: 0 }));
    expect(out.wasRetried).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxRetries on transient failure and succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = vi.fn().mockImplementation(() => {
      calls++;
      if (calls < 3) return Promise.reject(new Error(`fail-${calls}`));
      return Promise.resolve('ok');
    });

    const promise = executeWithRetry(fn, opts({ maxRetries: 3 }));
    await vi.runAllTimersAsync();
    const out = await promise;

    expect(out.result).toBe('ok');
    expect(out.wasRetried).toBe(true);
    expect(out.retryCount).toBe(2);
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('returns lastError after exhausting retries', async () => {
    vi.useFakeTimers();
    const err = new Error('persistent');
    const fn = vi.fn().mockRejectedValue(err);
    const promise = executeWithRetry(fn, opts({ maxRetries: 2 }));
    await vi.runAllTimersAsync();
    const out = await promise;
    expect(out.result).toBeUndefined();
    expect(out.lastError).toBe(err);
    expect(out.retryCount).toBe(2);
    expect(out.wasRetried).toBe(true);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    vi.useRealTimers();
  });
});
