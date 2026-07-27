import { describe, expect, it, vi } from 'vitest';

import {
  BOUNDED_CAPABILITY_TIMEOUT_REASON,
  INVENTORY_CANCELLED_REASON,
} from './inventory-helpers.js';
import { invokeBoundedTargetResolution } from './target-resolver-bounds.js';
import { MAX_BOUNDED_CAPABILITY_MS } from './types.js';

const REASON_CODES = { failure: 'fixture-failed', invalid: 'fixture-invalid' } as const;

function resolution(files: readonly string[] = []) {
  return { files: [...files], capped: false, cancelled: false };
}

describe('invokeBoundedTargetResolution foreign-capability bounds', () => {
  it('returns a well-formed resolution unchanged', async () => {
    const reasons = new Set<string>();

    const resolved = await invokeBoundedTargetResolution(
      () => Promise.resolve(resolution(['/a.ts'])),
      8,
      reasons,
      REASON_CODES,
    );

    expect(resolved?.files).toEqual(['/a.ts']);
    expect([...reasons]).toEqual([]);
  });

  it('abandons a capability that never answers, instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      const reasons = new Set<string>();
      // The capability never settles. Without a bound this promise would keep the whole
      // inventory build pending regardless of every entry/byte/file ceiling it owns.
      const pending = invokeBoundedTargetResolution(
        () =>
          new Promise<never>(() => {
            /* a capability that never answers */
          }),
        8,
        reasons,
        REASON_CODES,
      );

      await vi.advanceTimersByTimeAsync(MAX_BOUNDED_CAPABILITY_MS);

      expect(await pending).toBeUndefined();
      expect(reasons.has(BOUNDED_CAPABILITY_TIMEOUT_REASON)).toBe(true);
      expect(reasons.has(REASON_CODES.failure)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons a hung capability as soon as the run is cancelled', async () => {
    const reasons = new Set<string>();
    const controller = new AbortController();
    const pending = invokeBoundedTargetResolution(
      () =>
        new Promise<never>(() => {
          /* a capability that never answers */
        }),
      8,
      reasons,
      REASON_CODES,
      controller.signal,
    );

    controller.abort();

    expect(await pending).toBeUndefined();
    // A capability that was interrupted before answering is not a capability that failed:
    // attributing a host fault here would publish a fault nobody observed.
    expect([...reasons]).toEqual([INVENTORY_CANCELLED_REASON]);
  });

  it('keeps an observed fault that a simultaneous cancellation would otherwise erase', async () => {
    const reasons = new Set<string>();
    const controller = new AbortController();

    const resolved = await invokeBoundedTargetResolution(
      () => {
        controller.abort();
        return Promise.reject(new Error('fixture rejection after abort'));
      },
      8,
      reasons,
      REASON_CODES,
      controller.signal,
    );

    expect(resolved).toBeUndefined();
    expect([...reasons].sort()).toEqual([REASON_CODES.failure, INVENTORY_CANCELLED_REASON].sort());
  });

  it('keeps an observed malformed answer that a simultaneous cancellation would erase', async () => {
    const reasons = new Set<string>();
    const controller = new AbortController();

    const resolved = await invokeBoundedTargetResolution(
      () => {
        controller.abort();
        return Promise.resolve({ files: [], capped: 'no', cancelled: false });
      },
      8,
      reasons,
      REASON_CODES,
      controller.signal,
    );

    expect(resolved).toBeUndefined();
    expect([...reasons].sort()).toEqual([REASON_CODES.invalid, INVENTORY_CANCELLED_REASON].sort());
  });

  it('tolerates a duck-typed signal at the internal seam instead of crashing', async () => {
    const reasons = new Set<string>();
    const notASignal = { aborted: false } as AbortSignal;

    const resolved = await invokeBoundedTargetResolution(
      () => Promise.resolve(resolution(['/a.ts'])),
      8,
      reasons,
      REASON_CODES,
      notASignal,
    );

    expect(resolved?.files).toEqual(['/a.ts']);
    expect([...reasons]).toEqual([]);
  });
});
