/**
 * Execution substrate — scheduleUnits (loop/concurrency/stop), runWithTimeout
 * (the §4.3 timeout fix), runWithRetry (the fitness-hoisted retry), executePipeline
 * (the combinator), and deriveRecipeId.
 */

import { describe, it, expect, vi } from 'vitest';

import { deriveRecipeId } from '../../recipe-id.js';
import { RunScope } from '../../run-scope-class.js';
import { runWithScope } from '../../scope-storage.js';
import { executePipeline } from '../pipeline.js';
import { runWithRetry } from '../retry.js';
import { runWithTimeout } from '../run-with-timeout.js';
import { scheduleUnits } from '../schedule.js';

describe('deriveRecipeId', () => {
  it('derives <prefix>_<name>, preserving existing schemes', () => {
    expect(deriveRecipeId('RCP', 'example')).toBe('RCP_example');
    expect(deriveRecipeId('GRCP', 'default')).toBe('GRCP_default');
    expect(deriveRecipeId('BSCP', 'default')).toBe('BSCP_default');
  });
});

describe('runWithTimeout', () => {
  it('classifies a fast run as ok', async () => {
    const out = await runWithTimeout({
      run: () => Promise.resolve(42),
      timeoutMs: 1000,
    });
    expect(out.status).toBe('ok');
    expect(out.status === 'ok' && out.result).toBe(42);
  });

  it('clears the hard-timeout timer when the unit finishes first', async () => {
    vi.useFakeTimers();
    try {
      const out = await runWithTimeout({
        run: () => Promise.resolve(42),
        timeoutMs: 1000,
      });
      expect(out.status).toBe('ok');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ABORTS a runaway run and classifies it as timeout (the §4.3 sim fix)', async () => {
    const out = await runWithTimeout({
      // A run that never resolves on its own — only the timeout's abort ends it.
      run: (signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      timeoutMs: 20,
    });
    expect(out.status).toBe('timeout');
  });

  it('classifies a thrown domain error as error (not timeout)', async () => {
    const out = await runWithTimeout({
      run: () => Promise.reject(new Error('boom')),
      timeoutMs: 1000,
    });
    expect(out.status).toBe('error');
    expect(out.status === 'error' && (out.error as Error).message).toBe('boom');
  });

  it('detaches the parent-signal listener when the hard timeout wins a non-settling run', async () => {
    // Regression: detachParent() ran only inside the workPromise branches, so a
    // hard timeout winning the race against a callee that never settles (and
    // never fires the parent) left the parent 'abort' listener attached for the
    // parent signal's whole lifetime — one leaked listener per such unit on the
    // shared root signal, violating the parentSignal "no leaked listeners" contract.
    const parent = new AbortController();
    const removeSpy = vi.spyOn(parent.signal, 'removeEventListener');
    const out = await runWithTimeout({
      // Never settles and ignores abort → only the hard timeout ends the race.
      run: () =>
        new Promise<number>(() => {
          /* intentionally never settles */
        }),
      timeoutMs: 10,
      parentSignal: parent.signal,
    });
    expect(out.status).toBe('timeout');
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    removeSpy.mockRestore();
  });

  it('settles promptly when the parent aborts a non-cooperative run', async () => {
    const parent = new AbortController();
    const pending = runWithTimeout({
      run: () =>
        new Promise<number>(() => {
          /* intentionally ignores the signal and never settles */
        }),
      timeoutMs: 60_000,
      parentSignal: parent.signal,
    });
    parent.abort(new Error('parent cancelled'));
    const out = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('parent cancellation did not settle')), 250);
      }),
    ]);
    expect(out.status).toBe('error');
    expect(out.status === 'error' && (out.error as Error).message).toBe('parent cancelled');
  });

  it('defaults parentSignal to the host scope abortSignal (cancellation for free)', async () => {
    // The substrate composes currentScope().abortSignal when no parentSignal is
    // passed, so every tool running through runWithTimeout inherits OS-interrupt
    // cancellation with zero wiring. A pre-aborted host signal short-circuits the
    // unit to a cancelled error and the domain run never executes.
    const host = new AbortController();
    host.abort();
    const scope = new RunScope({ abortSignal: host.signal });
    const run = vi.fn(() => Promise.resolve(42));
    try {
      const out = await runWithScope(scope, () => runWithTimeout({ run, timeoutMs: 1000 }));
      expect(out.status).toBe('error');
      expect(run).not.toHaveBeenCalled();
    } finally {
      scope.dispose();
    }
  });

  describe('with a retry policy (the retry branch)', () => {
    const retry = { enabled: true, maxRetries: 2, backoffMs: [0, 0] } as const;

    it('returns ok with the result when the retried run succeeds', async () => {
      let calls = 0;
      const out = await runWithTimeout({
        run: () => {
          calls++;
          return calls < 2 ? Promise.reject(new Error('flaky')) : Promise.resolve('healed');
        },
        timeoutMs: 1000,
        retry,
      });
      expect(out.status).toBe('ok');
      expect(out.status === 'ok' && out.result).toBe('healed');
      expect(calls).toBe(2);
    });

    it('returns error with lastError when every retried attempt throws', async () => {
      const out = await runWithTimeout({
        run: () => Promise.reject(new Error('always')),
        timeoutMs: 1000,
        retry,
      });
      expect(out.status).toBe('error');
      expect(out.status === 'error' && (out.error as Error).message).toBe('always');
    });

    it('classifies a timeout while retrying as timeout (single-source abort)', async () => {
      // The run rejects synchronously on each attempt without ever resolving the
      // domain value, so retry keeps re-invoking it. Meanwhile the short timeout
      // aborts the controller mid-retry; after retry settles, the post-run
      // `signal.aborted` check maps the outcome to timeout, not error.
      const out = await runWithTimeout({
        run: () =>
          new Promise<number>((_resolve, reject) => {
            setTimeout(() => reject(new Error('slow-fail')), 20);
          }),
        timeoutMs: 10,
        retry,
      });
      expect(out.status).toBe('timeout');
    });
  });
});

describe('runWithRetry', () => {
  it('returns the result on first success (no retry)', async () => {
    const out = await runWithRetry(() => Promise.resolve('ok'), {
      enabled: true,
      maxRetries: 2,
      backoffMs: [0, 0],
    });
    expect(out).toMatchObject({
      result: 'ok',
      wasRetried: false,
      retryCount: 0,
    });
  });

  it('retries on throw up to maxRetries then returns lastError', async () => {
    let calls = 0;
    const out = await runWithRetry(
      () => {
        calls++;
        return Promise.reject(new Error(`fail ${calls}`));
      },
      { enabled: true, maxRetries: 2, backoffMs: [0, 0] },
    );
    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(out.result).toBeUndefined();
    expect(out.wasRetried).toBe(true);
  });

  it('does NOT retry when shouldNotRetry matches (e.g. an abort)', async () => {
    let calls = 0;
    class AbortLike extends Error {}
    const out = await runWithRetry(
      () => {
        calls++;
        return Promise.reject(new AbortLike());
      },
      {
        enabled: true,
        maxRetries: 3,
        shouldNotRetry: (e) => e instanceof AbortLike,
        backoffMs: [0, 0],
      },
    );
    expect(calls).toBe(1);
    expect(out.wasRetried).toBe(false);
  });

  /**
   * M5: shouldNotRetry was only checked on the first failure. A later attempt
   * that throws a non-retryable error must stop the train immediately.
   */
  it('stops mid-retry when shouldNotRetry matches a later failure (M5)', async () => {
    let calls = 0;
    class AbortLike extends Error {}
    const out = await runWithRetry(
      () => {
        calls++;
        // First failure is retryable; second is an abort.
        if (calls === 1) return Promise.reject(new Error('transient'));
        return Promise.reject(new AbortLike());
      },
      {
        enabled: true,
        maxRetries: 5,
        shouldNotRetry: (e) => e instanceof AbortLike,
        backoffMs: [0, 0, 0, 0, 0],
      },
    );
    expect(calls).toBe(2);
    expect(out.wasRetried).toBe(true);
    expect(out.retryCount).toBe(1);
    expect(out.lastError).toBeInstanceOf(AbortLike);
  });

  it('runs once when disabled', async () => {
    let calls = 0;
    await runWithRetry(
      () => {
        calls++;
        return Promise.reject(new Error('x'));
      },
      { enabled: false, maxRetries: 5 },
    );
    expect(calls).toBe(1);
  });
});

describe('scheduleUnits', () => {
  it('stops scheduling when the host scope abortSignal is aborted (for free)', async () => {
    // Besides the caller's shouldAbort, the scheduler observes the host-owned root
    // cancel signal, so an OS interrupt stops launching new units on every
    // substrate-based tool with no wiring. A pre-aborted host signal launches none.
    const host = new AbortController();
    host.abort();
    const scope = new RunScope({ abortSignal: host.signal });
    const runUnit = vi.fn(() => Promise.resolve({ shouldStop: false }));
    try {
      await runWithScope(scope, () =>
        scheduleUnits<number>({ units: [1, 2, 3], mode: 'sequential', runUnit }),
      );
      expect(runUnit).not.toHaveBeenCalled();
    } finally {
      scope.dispose();
    }
  });

  it('runs sequential in order and stops on shouldStop', async () => {
    const seen: number[] = [];
    await scheduleUnits<number>({
      units: [1, 2, 3, 4],
      mode: 'sequential',
      runUnit: (u) => {
        seen.push(u);
        return Promise.resolve({ shouldStop: u === 2 });
      },
    });
    expect(seen).toEqual([1, 2]); // stopped after unit 2
  });

  it('respects maxParallel concurrency in parallel mode', async () => {
    let active = 0;
    let maxActive = 0;
    const runUnit = async (): Promise<{ shouldStop: boolean }> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { shouldStop: false };
    };
    await scheduleUnits<number>({
      units: [1, 2, 3, 4, 5, 6],
      mode: 'parallel',
      maxParallel: 2,
      runUnit,
    });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('resolves (does not hang) when abort is already signaled at entry (parallel)', async () => {
    // Regression: in parallel mode `resolve()` was only reachable from a launched
    // unit's `.finally()`. With abort already signaled before the first launch,
    // zero units launched and the promise never settled — an infinite hang. This
    // test would time out on the old code; it now returns immediately.
    const seen: number[] = [];
    await scheduleUnits<number>({
      units: [1, 2, 3],
      mode: 'parallel',
      maxParallel: 2,
      shouldAbort: () => true, // aborted before the initial batch launches
      runUnit: (u) => {
        seen.push(u);
        return Promise.resolve({ shouldStop: false });
      },
    });
    expect(seen).toEqual([]); // nothing launched — and, critically, it resolved
  });

  it('honours an external abort (sequential)', async () => {
    const seen: number[] = [];
    let aborted = false;
    await scheduleUnits<number>({
      units: [1, 2, 3],
      mode: 'sequential',
      shouldAbort: () => aborted,
      runUnit: (u) => {
        seen.push(u);
        aborted = u === 1;
        return Promise.resolve({ shouldStop: false });
      },
    });
    // Sequential checks the abort flag at the TOP of each iteration: unit 1 runs
    // and flips `aborted`, so unit 2's top-check breaks before it launches.
    expect(seen).toEqual([1]);
  });

  it('yieldBetweenUnits runs every unit in order through the macrotask-yield wrapper (sequential)', async () => {
    // Exercises the yieldToEventLoop boundary path: each unit resolves after a
    // setImmediate turn, so a same-thread live-progress timer could paint between
    // units. Behaviour (order, stop policy) is unchanged from the no-yield path.
    const seen: number[] = [];
    await scheduleUnits<number>({
      units: [1, 2, 3],
      mode: 'sequential',
      yieldBetweenUnits: true,
      runUnit: (u) => {
        seen.push(u);
        return Promise.resolve({ shouldStop: false });
      },
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('yieldBetweenUnits also applies in parallel mode (all units still run)', async () => {
    const seen: number[] = [];
    await scheduleUnits<number>({
      units: [1, 2, 3, 4],
      mode: 'parallel',
      maxParallel: 2,
      yieldBetweenUnits: true,
      runUnit: (u) => {
        seen.push(u);
        return Promise.resolve({ shouldStop: false });
      },
    });
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  /**
   * M1: fractional maxParallel used to over-launch (e.g. 2.9 → three iterations
   * of the initial for-loop). Floor to integer concurrency.
   */
  it('floors fractional maxParallel so concurrency is never over-launched (M1)', async () => {
    let active = 0;
    let maxActive = 0;
    await scheduleUnits<number>({
      units: [1, 2, 3, 4, 5, 6],
      mode: 'parallel',
      maxParallel: 2.9,
      runUnit: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { shouldStop: false };
      },
    });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  /**
   * M3: a rejecting runUnit must not leave an unhandled rejection; the
   * scheduler surfaces the error and drains.
   */
  it('rejects cleanly when a parallel runUnit throws (M3 unhandled rejection)', async () => {
    await expect(
      scheduleUnits<number>({
        units: [1, 2, 3],
        mode: 'parallel',
        maxParallel: 2,
        runUnit: (u) => {
          if (u === 1) return Promise.reject(new Error('unit-boom'));
          return Promise.resolve({ shouldStop: false });
        },
      }),
    ).rejects.toThrow(/unit-boom/);
  });
});

describe('executePipeline (combinator)', () => {
  it('schedules, times out, and maps outcomes', async () => {
    const statuses: string[] = [];
    await executePipeline<number, number>({
      units: [1, 2, 3],
      options: { mode: 'sequential', timeout: 30 },
      runOne: (u, signal) =>
        u === 2
          ? new Promise<number>((_r, reject) =>
              signal.addEventListener('abort', () => reject(new Error('to'))),
            )
          : Promise.resolve(u * 10),
      onResult: (_u, _i, outcome) => {
        statuses.push(outcome.status);
        return { shouldStop: false };
      },
    });
    expect(statuses).toEqual(['ok', 'timeout', 'ok']);
  });

  it('threads maxParallel, shouldAbort, retry, and a per-unit timeoutFor override', async () => {
    const seen: number[] = [];
    const timeoutUnits: number[] = [];
    let aborted = false;
    await executePipeline<number, number>({
      units: [1, 2, 3, 4],
      options: {
        mode: 'parallel',
        maxParallel: 2,
        timeout: 1000,
        retry: { enabled: true, maxRetries: 1 },
      },
      timeoutFor: (u) => {
        timeoutUnits.push(u);
        return 50;
      },
      shouldAbort: () => aborted,
      runOne: (u) => Promise.resolve(u),
      onResult: (u, _i, outcome) => {
        seen.push(u);
        if (u === 4) aborted = true;
        expect(outcome.status).toBe('ok');
        return { shouldStop: false };
      },
    });
    // Every scheduled unit went through the per-unit timeout override path.
    expect(timeoutUnits.length).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe('runWithTimeout — a completed result outlives a concurrent cancellation', () => {
  it('returns the result when the parent aborts while the unit is finishing', async () => {
    // Regression: the parent-abort branch used to run AFTER the work resolved and
    // replaced the value with a cancellation error. That branch was effectively dead
    // until parentSignal began defaulting to the ambient scope signal, at which point
    // every interrupt silently discarded evidence a unit had already produced.
    const parent = new AbortController();
    const out = await runWithTimeout({
      run: () => {
        parent.abort(); // interrupt arrives while this unit is completing
        return Promise.resolve('observed');
      },
      timeoutMs: 1000,
      parentSignal: parent.signal,
    });
    expect(out.status).toBe('ok');
    expect(out.status === 'ok' && out.result).toBe('observed');
  });

  it('still reports cancellation when the unit produced nothing', async () => {
    const parent = new AbortController();
    parent.abort();
    const out = await runWithTimeout({
      run: () => Promise.resolve(1),
      timeoutMs: 1000,
      parentSignal: parent.signal,
    });
    // Pre-aborted: the unit never runs, so there is no evidence to preserve.
    expect(out.status).toBe('error');
  });

  it('a timeout still wins over a late result', async () => {
    const out = await runWithTimeout({
      run: (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => resolve('late'), { once: true });
        }),
      timeoutMs: 10,
    });
    expect(out.status, 'the single-source abort invariant must hold').toBe('timeout');
  });
});
