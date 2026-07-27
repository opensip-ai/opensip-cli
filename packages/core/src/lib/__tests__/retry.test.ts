import { describe, it, expect, vi } from 'vitest';

import { defineErrorCatalog } from '../../lib/error-definition.js';
import { createToolError, NetworkError } from '../../lib/errors.js';
import {
  abortableSleep,
  createCancelledError,
  createDeadlineError,
  defaultShouldRetry,
  withRetry,
} from '../../lib/retry.js';

describe('withRetry', () => {
  it('returns immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail1')).mockResolvedValue('ok');

    const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after max attempts exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(withRetry(fn, { maxAttempts: 3, initialDelayMs: 10 })).rejects.toThrow(
      'always fails',
    );

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('calls onRetry callback before each retry', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
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
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('ok');

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

    await expect(withRetry(fn, { maxAttempts: 1 })).rejects.toThrow('string error');
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

    await expect(withRetry(fn, { maxAttempts: Number.NaN, initialDelayMs: 10 })).rejects.toThrow(
      'boom',
    );

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('aborts during backoff when signal fires', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error('transient'));
    const clock = {
      now: () => 0,
      random: () => 0,
      sleep: (_ms: number, signal?: AbortSignal) => {
        controller.abort();
        if (signal?.aborted) return Promise.reject(new Error('aborted-sleep'));
        return Promise.resolve();
      },
    };

    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        initialDelayMs: 100,
        signal: controller.signal,
        clock,
        useDefinitionRetry: false,
      }),
    ).rejects.toThrow();
    expect(fn.mock.calls.length).toBeLessThan(5);
  });

  it('aborts even when an injected sleep implementation ignores the signal', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error('transient'));
    const clock = {
      now: () => 0,
      random: () => 0,
      sleep: () => {
        queueMicrotask(() => controller.abort());
        return new Promise<void>(() => {
          /* deliberately non-cooperative */
        });
      },
    };
    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        signal: controller.signal,
        clock,
        useDefinitionRetry: false,
      }),
    ).rejects.toMatchObject({ code: 'CORE.SYSTEM.CANCELLED' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry ToolError with retry:never', async () => {
    const { ValidationError } = await import('../../lib/errors.js');
    const fn = vi.fn().mockRejectedValue(new ValidationError('bad'));
    await expect(withRetry(fn, { maxAttempts: 5, initialDelayMs: 1 })).rejects.toThrow('bad');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('isolates onRetry throws from the operation', async () => {
    const onRetry = vi.fn(() => {
      throw new Error('observer boom');
    });
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('ok');
    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 1, onRetry, useDefinitionRetry: false }),
    ).resolves.toBe('ok');
  });

  it('fails before first attempt when signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(
      withRetry(fn, { signal: controller.signal, maxAttempts: 3, initialDelayMs: 1 }),
    ).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('does not retry cancelled errors', async () => {
    const { createCancelledError } = await import('../../lib/retry.js');
    const fn = vi.fn().mockRejectedValue(createCancelledError('stop'));
    await expect(withRetry(fn, { maxAttempts: 5, initialDelayMs: 1 })).rejects.toThrow(
      /stop|cancel/i,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects deadline via injectable clock', async () => {
    let now = 0;
    const clock = {
      now: () => now,
      random: () => 0,
      sleep: (ms: number) => {
        now += ms;
        return Promise.resolve();
      },
    };
    const fn = vi.fn().mockRejectedValue(new Error('transient'));
    await expect(
      withRetry(fn, {
        maxAttempts: 10,
        initialDelayMs: 50,
        // Absolute clock deadline (not a relative duration).
        deadlineMs: 30,
        // full jitter with random=0 yields 0 delay and would never advance time.
        jitter: 'none',
        clock,
        useDefinitionRetry: false,
      }),
    ).rejects.toThrow();
    expect(fn.mock.calls.length).toBeLessThan(10);
  });

  it('enforces the deadline while a non-cooperative attempt is still pending', async () => {
    const started = Date.now();
    await expect(
      withRetry(() => new Promise<never>(() => undefined), {
        maxAttempts: 3,
        deadlineMs: Date.now() + 25,
      }),
    ).rejects.toMatchObject({
      code: 'CORE.SYSTEM.DEADLINE_EXCEEDED',
      definition: { retry: 'never' },
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('keeps cancellation and deadline errors definition-backed', () => {
    expect(createCancelledError()).toMatchObject({
      code: 'CORE.SYSTEM.CANCELLED',
      definition: { kind: 'cancelled', retry: 'never' },
    });
    expect(createDeadlineError()).toMatchObject({
      code: 'CORE.SYSTEM.DEADLINE_EXCEEDED',
      definition: { kind: 'timeout', retry: 'never' },
    });
  });

  it('classifies transient and caller-policy definitions explicitly', () => {
    expect(defaultShouldRetry(new NetworkError('temporary'))).toBe(true);

    const catalog = defineErrorCatalog(
      { id: 'test.retry', displayName: 'Retry test' },
      {
        'TEST.RETRY.RESOURCE': {
          code: 'TEST.RETRY.RESOURCE',
          source: 'infrastructure',
          defaultResponsibility: 'environment',
          kind: 'resource',
          retry: 'caller-policy',
          severity: 'error',
          exposure: 'operator-only',
          exitClass: 'runtime',
          operatorAction: 'Retry if the operation is safe.',
          stability: 'internal',
          lifecycle: 'active',
        },
        'TEST.RETRY.VALIDATION': {
          code: 'TEST.RETRY.VALIDATION',
          source: 'application',
          defaultResponsibility: 'user',
          kind: 'validation',
          retry: 'caller-policy',
          severity: 'error',
          exposure: 'public',
          exitClass: 'configuration',
          operatorAction: 'Correct the input.',
          stability: 'internal',
          lifecycle: 'active',
        },
      },
    );
    expect(
      defaultShouldRetry(createToolError(catalog.require('TEST.RETRY.RESOURCE'), 'busy')),
    ).toBe(true);
    expect(
      defaultShouldRetry(createToolError(catalog.require('TEST.RETRY.VALIDATION'), 'bad input')),
    ).toBe(false);
  });

  it.each([
    { jitter: 'equal' as const, random: (): number => 0.5, expected: 75 },
    { jitter: 'decorrelated' as const, random: (): number => 0.5, expected: 150 },
    { jitter: 'full' as const, random: (): number => Number.NaN, expected: 0 },
    {
      jitter: 'full' as const,
      random: (): number => {
        throw new Error('broken entropy');
      },
      expected: 0,
    },
    { jitter: 'unsupported' as never, random: (): number => 0.5, expected: 50 },
  ])('computes bounded $jitter jitter with an isolated random source', async (entry) => {
    const sleep = vi.fn(() => Promise.resolve());
    const fn = vi.fn().mockRejectedValueOnce(new Error('retry')).mockResolvedValue('ok');
    await expect(
      withRetry(fn, {
        maxAttempts: 2,
        initialDelayMs: 100,
        maxDelayMs: 1000,
        jitter: entry.jitter,
        useDefinitionRetry: false,
        clock: { now: () => 0, random: entry.random, sleep },
      }),
    ).resolves.toBe('ok');
    expect(sleep).toHaveBeenCalledWith(entry.expected, undefined);
  });

  it.each([
    { name: 'finite override', override: () => -10, expected: 0 },
    { name: 'undefined override', override: () => undefined, expected: 100 },
    {
      name: 'throwing override',
      override: () => {
        throw new Error('bad policy');
      },
      expected: 100,
    },
  ])('isolates a $name retry-delay policy', async ({ override, expected }) => {
    const sleep = vi.fn(() => Promise.resolve());
    const fn = vi.fn().mockRejectedValueOnce(new Error('retry')).mockResolvedValue('ok');
    await withRetry(fn, {
      maxAttempts: 2,
      initialDelayMs: 100,
      jitter: 'none',
      retryDelayMs: override,
      useDefinitionRetry: false,
      clock: { now: () => 0, random: () => 0, sleep },
    });
    expect(sleep).toHaveBeenCalledWith(expected, undefined);
  });

  it('stops retrying when the caller policy throws and preserves the operation error', async () => {
    const failure = new Error('operation failed');
    const fn = vi.fn().mockRejectedValue(failure);
    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        useDefinitionRetry: false,
        shouldRetry: () => {
          throw new Error('policy failed');
        },
      }),
    ).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('normalizes a hostile non-Error rejection without rethrowing inspection failure', async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentionally models a hostile non-Error rejection crossing a plugin boundary
    const rejectHostile = (): Promise<never> => Promise.reject(revoked.proxy);
    await expect(withRetry(rejectHostile, { maxAttempts: 1 })).rejects.toThrow('object');
  });

  it('checks the remaining deadline after an attempt fails', async () => {
    const readings = [0, 0, 0, 10];
    const clock = {
      now: () => readings.shift() ?? 10,
      random: () => 0,
      sleep: () => Promise.resolve(),
    };
    await expect(
      withRetry(() => Promise.reject(new Error('temporary')), {
        maxAttempts: 2,
        deadlineMs: 10,
        useDefinitionRetry: false,
        clock,
      }),
    ).rejects.toMatchObject({ code: 'CORE.SYSTEM.DEADLINE_EXCEEDED' });
  });

  it('supports zero-delay sleep and cancellation both before and during backoff', async () => {
    await expect(abortableSleep(0)).resolves.toBeUndefined();

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(abortableSleep(1, alreadyAborted.signal)).rejects.toMatchObject({
      code: 'CORE.SYSTEM.CANCELLED',
    });

    vi.useFakeTimers();
    try {
      const duringBackoff = new AbortController();
      const pending = abortableSleep(100, duringBackoff.signal);
      duringBackoff.abort();
      await expect(pending).rejects.toMatchObject({ code: 'CORE.SYSTEM.CANCELLED' });
    } finally {
      vi.useRealTimers();
    }
  });
});
