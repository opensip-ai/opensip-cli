import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveProtectedCoordinationKeys } from '../ephemeral-runtime-prune-protection.js';

import type * as RuntimeLeaseModule from '../runtime-lease.js';

interface LeaseProbe {
  active: readonly string[];
  error: Error | undefined;
  calls: number;
}

const leaseProbe = vi.hoisted<LeaseProbe>(() => ({
  active: [],
  error: undefined,
  calls: 0,
}));

vi.mock('../runtime-lease.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeLeaseModule>();
  return {
    ...actual,
    listActiveRuntimeLeaseKeys: () => {
      leaseProbe.calls += 1;
      return leaseProbe.error === undefined
        ? Promise.resolve(leaseProbe.active)
        : Promise.reject(leaseProbe.error);
    },
  };
});

describe('ephemeral runtime prune protection', () => {
  beforeEach(() => {
    leaseProbe.active = [];
    leaseProbe.error = undefined;
    leaseProbe.calls = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips lease enumeration when the pass budget is already exhausted', async () => {
    await expect(
      resolveProtectedCoordinationKeys([], {
        expiresAt: 0,
        monotonicNow: () => 1,
      }),
    ).resolves.toBeUndefined();
    expect(leaseProbe.calls).toBe(0);
  });

  it('discards an active snapshot when the pass budget expires immediately after it', async () => {
    const observations = [0, 101];
    let index = 0;

    await expect(
      resolveProtectedCoordinationKeys(
        [],
        {
          expiresAt: 100,
          monotonicNow: () => observations[Math.min(index++, observations.length - 1)],
        },
        undefined,
        { afterActiveSnapshot: () => Promise.resolve() },
      ),
    ).resolves.toBeUndefined();
    expect(leaseProbe.calls).toBe(1);
  });

  it('fails closed when configured and active keys exceed the protection cap', async () => {
    const requested = Array.from({ length: 256 }, (_, index) =>
      index.toString(16).padStart(24, '0'),
    );
    leaseProbe.active = ['f'.repeat(24)];

    await expect(
      resolveProtectedCoordinationKeys(requested, {
        expiresAt: 100,
        monotonicNow: () => 0,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails closed when active lease enumeration throws', async () => {
    leaseProbe.error = new Error('injected lease enumeration failure');

    await expect(
      resolveProtectedCoordinationKeys([], {
        expiresAt: 100,
        monotonicNow: () => 0,
      }),
    ).resolves.toBeUndefined();
    expect(leaseProbe.calls).toBe(1);
  });
});
