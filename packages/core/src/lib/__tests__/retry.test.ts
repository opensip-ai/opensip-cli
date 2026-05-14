import { describe, it, expect, vi } from 'vitest';

import { withRetry } from '../../lib/retry.js';

describe('withRetry', () => {
  it('returns immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after max attempts exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 10 }),
    ).rejects.toThrow('always fails');

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('calls onRetry callback before each retry', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('ok');

    await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number));
    expect(onRetry).toHaveBeenCalledWith(2, expect.any(Error), expect.any(Number));
  });

  it('does not call onRetry if first attempt succeeds', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockResolvedValue('ok');

    await withRetry(fn, { onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('respects maxDelayMs cap', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    await withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 50,
      backoffMultiplier: 10,
      onRetry,
    });

    // The delay passed to onRetry should not exceed maxDelayMs
    const delay = onRetry.mock.calls[0][2];
    expect(delay).toBeLessThanOrEqual(50);
  });

  it('wraps non-Error throws in Error', async () => {
    const fn = vi.fn().mockRejectedValue('string error');

    await expect(
      withRetry(fn, { maxAttempts: 1 }),
    ).rejects.toThrow('string error');
  });

  it('runs at least once when maxAttempts is 0', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxAttempts: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws the underlying error (not undefined) when maxAttempts is NaN', async () => {
    // Math.max(1, NaN) returns NaN, so without the Number.isFinite guard the
    // for-loop never ran and `throw lastError!` propagated `undefined`.
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      withRetry(fn, { maxAttempts: Number.NaN, initialDelayMs: 10 }),
    ).rejects.toThrow('boom');

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
