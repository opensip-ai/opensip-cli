/**
 * @fileoverview Behaviour tests for the real load-window driver: it drives a
 * BYO target, measures latency, classifies outcomes, bounds concurrency, and
 * honours abort.
 */

import { describe, expect, it, vi } from 'vitest';

import { countingTarget, failingTarget } from '../../../__tests__/test-utils/targets.js';
import { runLoadWindow } from '../run-load-window.js';

import type { ScenarioExecutionContext } from '../../../types/framework-types.js';

const ctx = (signal: AbortSignal): ScenarioExecutionContext => ({
  scenarioId: 't',
  correlationId: 'c',
  abortSignal: signal,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

describe('runLoadWindow', () => {
  it('dispatches exactly one request at the 1 RPS / 1 second boundary', async () => {
    vi.useFakeTimers();
    try {
      const ct = countingTarget();
      const run = runLoadWindow({ workload: { rps: 1 } }, ctx(new AbortController().signal), {
        windowMs: 1000,
        target: ct.target,
      });

      await vi.advanceTimersByTimeAsync(1000);
      const result = await run;

      expect(result.metrics.totalRequests).toBe(1);
      expect(result.metrics.successfulRequests).toBe(1);
      expect(ct.calls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not round a genuinely fractional request budget upward', async () => {
    vi.useFakeTimers();
    try {
      const ct = countingTarget();
      const run = runLoadWindow({ workload: { rps: 2.5 } }, ctx(new AbortController().signal), {
        windowMs: 1000,
        target: ct.target,
      });

      await vi.advanceTimersByTimeAsync(1000);
      const result = await run;

      expect(result.metrics.totalRequests).toBe(2);
      expect(ct.calls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { expected: 3, rps: 0.3 },
    { expected: 33, rps: 3.3 },
  ])('preserves the $rps RPS budget across a long fractional window', async ({ expected, rps }) => {
    vi.useFakeTimers();
    try {
      const ct = countingTarget();
      const run = runLoadWindow({ workload: { rps } }, ctx(new AbortController().signal), {
        windowMs: 10_000,
        target: ct.target,
      });

      await vi.advanceTimersByTimeAsync(10_000);
      const result = await run;

      expect(result.metrics.totalRequests).toBe(expected);
      expect(ct.calls()).toBe(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { expected: 0, rps: 1 - Number.EPSILON / 2, windowMs: 1000 },
    { expected: 32, rps: 3.3 - Number.EPSILON * 4, windowMs: 10_000 },
  ])(
    'does not round the $rps RPS budget across $windowMs ms upward',
    async ({ expected, rps, windowMs }) => {
      vi.useFakeTimers();
      try {
        const ct = countingTarget();
        const run = runLoadWindow({ workload: { rps } }, ctx(new AbortController().signal), {
          windowMs,
          target: ct.target,
        });

        await vi.advanceTimersByTimeAsync(windowMs);
        const result = await run;

        expect(result.metrics.totalRequests).toBe(expected);
        expect(ct.calls()).toBe(expected);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('drives the target and counts every resolve as a success', async () => {
    const ct = countingTarget();
    const r = await runLoadWindow({ workload: { rps: 50 } }, ctx(new AbortController().signal), {
      windowMs: 300,
      target: ct.target,
    });
    expect(r.metrics.totalRequests).toBeGreaterThan(0);
    expect(ct.calls()).toBe(r.metrics.totalRequests);
    expect(r.metrics.successfulRequests).toBe(r.metrics.totalRequests);
    expect(r.metrics.failedRequests).toBe(0);
  });

  it('counts every throw as a failure + error', async () => {
    const r = await runLoadWindow({ workload: { rps: 50 } }, ctx(new AbortController().signal), {
      windowMs: 300,
      target: failingTarget,
    });
    expect(r.metrics.totalRequests).toBeGreaterThan(0);
    expect(r.metrics.successfulRequests).toBe(0);
    expect(r.metrics.failedRequests).toBe(r.metrics.totalRequests);
    expect(r.metrics.errorsGenerated).toBe(r.metrics.failedRequests);
  });

  it('never exceeds the workload concurrency cap', async () => {
    const ct = countingTarget(40);
    await runLoadWindow(
      { workload: { rps: 200, concurrency: 3 } },
      ctx(new AbortController().signal),
      {
        windowMs: 400,
        target: ct.target,
      },
    );
    expect(ct.maxConcurrent()).toBeLessThanOrEqual(3);
    expect(ct.calls()).toBeGreaterThan(0);
  });

  it('does not hang when concurrency is 0 (clamped to ≥ 1)', async () => {
    const ct = countingTarget();
    const r = await runLoadWindow(
      { workload: { rps: 50, concurrency: 0 } },
      ctx(new AbortController().signal),
      {
        windowMs: 250,
        target: ct.target,
      },
    );
    expect(r.metrics.totalRequests).toBeGreaterThan(0);
    expect(ct.maxConcurrent()).toBeLessThanOrEqual(1);
  });

  it('records real measured latency in the snapshot', async () => {
    const ct = countingTarget(20);
    const r = await runLoadWindow({ workload: { rps: 20 } }, ctx(new AbortController().signal), {
      windowMs: 300,
      target: ct.target,
    });
    expect(r.metrics.p50LatencyMs).toBeGreaterThanOrEqual(15);
  });

  it('applies ramp-up (issues fewer requests early)', async () => {
    const ct = countingTarget();
    const r = await runLoadWindow(
      { workload: { rps: 100, rampUp: 1 } },
      ctx(new AbortController().signal),
      {
        windowMs: 300,
        target: ct.target,
      },
    );
    // With a 1s ramp and a 300ms window, the loop never reaches full rps, so it
    // issues materially fewer than rps*window would suggest — but still > 0.
    expect(r.metrics.totalRequests).toBeGreaterThan(0);
    expect(r.metrics.totalRequests).toBeLessThan(30);
  });

  it('propagates a pre-aborted run without issuing requests', async () => {
    const ac = new AbortController();
    ac.abort();
    const ct = countingTarget();
    await expect(
      runLoadWindow({ workload: { rps: 50 } }, ctx(ac.signal), {
        windowMs: 1000,
        target: ct.target,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(ct.calls()).toBe(0);
  });

  it('stops dispatching after a mid-window abort and propagates cancellation', async () => {
    const ac = new AbortController();
    const ct = countingTarget(5);
    setTimeout(() => ac.abort(), 120);
    await expect(
      runLoadWindow({ workload: { rps: 100 } }, ctx(ac.signal), {
        windowMs: 5000,
        target: ct.target,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(ct.calls()).toBeGreaterThan(0);
    expect(ct.calls()).toBeLessThan(100);
  });
});
