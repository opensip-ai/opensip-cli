/**
 * @fileoverview Behaviour tests for the client-side fault model. Determinism
 * comes from an injected RNG sequence so perturbed counts are exact.
 */

import { describe, expect, it } from 'vitest';

import { countingTarget, noopTarget } from '../../../__tests__/test-utils/targets.js';
import { fault } from '../fault-builders.js';
import { createFaultModel } from '../fault-model.js';

import type { TargetContext } from '../target.js';

const ctx: TargetContext = {
  signal: new AbortController().signal,
  correlationId: 'c',
};

/** RNG that walks a fixed sequence (wraps). */
const seq = (vals: readonly number[]) => {
  let i = 0;
  return (): number => vals[i++ % vals.length] ?? 0;
};

describe('createFaultModel', () => {
  it('perturbs exactly the requests whose draw < probability', async () => {
    const ct = countingTarget();
    const fm = createFaultModel(fault.of([fault.drop()], { probability: 0.5 }), {
      rng: seq([0.4, 0.6, 0.4, 0.6]),
    });
    const wrapped = fm.wrap(ct.target);
    const results = await Promise.allSettled([
      wrapped(ctx),
      wrapped(ctx),
      wrapped(ctx),
      wrapped(ctx),
    ]);

    // Draws 0.4 and 0.4 (< 0.5) → dropped (rejected); 0.6 and 0.6 → passed through.
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
    expect(ct.calls()).toBe(2); // dropped requests never reach the target
    expect(fm.drained()).toHaveLength(2);
    expect(fm.drained().every((f) => f.kind === 'drop')).toBe(true);
  });

  it('latency fault delays the real call (target still runs)', async () => {
    const ct = countingTarget();
    const fm = createFaultModel(fault.of([fault.latency({ ms: 50 })], { probability: 1 }), {
      rng: () => 0,
    });
    const start = Date.now();
    await fm.wrap(ct.target)(ctx);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
    expect(ct.calls()).toBe(1);
  });

  it('abort fault fails even when the target ignores the signal', async () => {
    const fm = createFaultModel(fault.of([fault.abort()], { probability: 1 }), {
      rng: () => 0,
    });
    await expect(fm.wrap(noopTarget)(ctx)).rejects.toThrow();
    expect(fm.drained()).toHaveLength(1);
    expect(fm.drained()[0]?.kind).toBe('abort');
  });

  it('does not perturb when probability is 0', async () => {
    const ct = countingTarget();
    const fm = createFaultModel(fault.of([fault.drop()], { probability: 0 }), {
      rng: () => 0,
    });
    await fm.wrap(ct.target)(ctx);
    expect(ct.calls()).toBe(1);
    expect(fm.drained()).toHaveLength(0);
  });

  it('round-robins across multiple fault kinds deterministically', async () => {
    const fm = createFaultModel(
      fault.of([fault.drop(), fault.latency({ ms: 1 })], { probability: 1 }),
      { rng: () => 0 },
    );
    const wrapped = fm.wrap(noopTarget);
    await Promise.allSettled([wrapped(ctx), wrapped(ctx), wrapped(ctx)]);
    expect(fm.drained().map((f) => f.kind)).toEqual(['drop', 'latency', 'drop']);
  });
});
