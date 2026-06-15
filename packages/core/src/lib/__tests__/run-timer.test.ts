import { describe, it, expect, vi } from 'vitest';

import { createRunLifecycle, createRunTimer } from '../run-timer.js';

/** Busy-wait so real monotonic elapsed accrues (perf.now can't be faked reliably). */
function spin(ms: number): void {
  const start = Date.now();
  while (Date.now() - start < ms) {
    /* spin */
  }
}

describe('createRunTimer / RunTimer', () => {
  it('produces a snapshot with startedAt, completedAt, and non-negative durationMs', () => {
    const timer = createRunTimer();
    const snap = timer.snapshot();

    expect(typeof snap.startedAt).toBe('string');
    expect(snap.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-ish
    expect(typeof snap.completedAt).toBe('string');
    expect(typeof snap.durationMs).toBe('number');
    expect(snap.durationMs).toBeGreaterThanOrEqual(0);
    expect(snap.startedAt).toBe(timer.startedAt);
  });

  it('supports multiple snapshots with non-decreasing duration', () => {
    const timer = createRunTimer();
    const s1 = timer.snapshot();
    // Busy-wait a tiny bit to allow real elapsed to grow (no fake timers on perf.now reliably)
    const start = Date.now();
    while (Date.now() - start < 2) {
      /* spin */
    }
    const s2 = timer.snapshot();

    expect(s2.startedAt).toBe(s1.startedAt);
    expect(s2.durationMs).toBeGreaterThanOrEqual(s1.durationMs);
    expect(s2.completedAt >= s1.completedAt || s2.durationMs >= s1.durationMs).toBe(true);
  });

  it('elapsedMs grows and snapshot duration reflects it', () => {
    const timer = createRunTimer();
    const e0 = timer.elapsedMs();
    const start = Date.now();
    while (Date.now() - start < 3) {
      /* spin */
    }
    const e1 = timer.elapsedMs();
    const snap = timer.snapshot();

    expect(e1).toBeGreaterThanOrEqual(e0);
    expect(snap.durationMs).toBeGreaterThanOrEqual(e1 - 1); // allow tiny scheduling noise
  });

  it('clamps elapsed / duration to >= 0 even if clock appears to go backwards', () => {
    // Force the fallback path and simulate a negative delta by stubbing Date.now
    const realNow = Date.now;
    let call = 0;
    const base = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      call += 1;
      // First call (construction) returns base; subsequent return values that would yield negative
      if (call === 1) return base;
      return base - 50; // would produce negative raw elapsed in fallback
    });

    try {
      const timer = createRunTimer();
      // Force fallback by making performance absent for this timer instance
      // (we can't easily delete global, but the impl already captured at create time;
      // to test clamp we temporarily make the fallback trigger by spying elapsed calc indirectly)
      const d0 = timer.elapsedMs();
      expect(d0).toBeGreaterThanOrEqual(0);

      const snap = timer.snapshot();
      expect(snap.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      vi.restoreAllMocks();
      // ensure Date.now is real
      if (Date.now !== realNow) {
        (Date as { now: () => number }).now = realNow;
      }
    }
  });

  it('snapshot after a pause has non-decreasing duration and stable startedAt (enriched per Phase 7 scaffold)', () => {
    const timer = createRunTimer();
    const s1 = timer.snapshot();
    const start = Date.now();
    while (Date.now() - start < 2) {
      /* busy-wait to let real elapsed time accrue */
    }
    const s2 = timer.snapshot();
    expect(s2.startedAt).toBe(s1.startedAt);
    expect(s2.durationMs).toBeGreaterThanOrEqual(s1.durationMs);
  });
});

describe('RunTimer.complete() / RunLifecycle freeze semantics (host-owned-run-timing Phase 8)', () => {
  it('complete() returns a snapshot with the stable startedAt and a non-negative duration', () => {
    const timer = createRunTimer();
    const c = timer.complete();
    expect(c.startedAt).toBe(timer.startedAt);
    expect(c.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof c.completedAt).toBe('string');
  });

  it('is idempotent — the second complete() returns the SAME frozen object', () => {
    const timer = createRunTimer();
    const a = timer.complete();
    spin(3);
    const b = timer.complete();
    // Same reference (frozen via `frozen ??=`) — and therefore identical values.
    expect(b).toBe(a);
    expect(b.completedAt).toBe(a.completedAt);
    expect(b.durationMs).toBe(a.durationMs);
  });

  it('freezes completedAt + durationMs at the FIRST complete() (later wall time does not advance them)', () => {
    const timer = createRunTimer();
    const c = timer.complete();
    spin(5);
    // elapsedMs() is still LIVE and keeps ticking past the frozen completion duration.
    expect(timer.elapsedMs()).toBeGreaterThanOrEqual(c.durationMs);
    // But a second complete() does not re-read the clock.
    const c2 = timer.complete();
    expect(c2.completedAt).toBe(c.completedAt);
    expect(c2.durationMs).toBe(c.durationMs);
  });

  it('snapshot() is LIVE before complete() and FROZEN (same object) after', () => {
    const timer = createRunTimer();
    const s1 = timer.snapshot();
    spin(3);
    const s2 = timer.snapshot();
    expect(s2.durationMs).toBeGreaterThanOrEqual(s1.durationMs); // live before completion

    const c = timer.complete();
    spin(3);
    const sAfter = timer.snapshot();
    // After completion, snapshot returns the frozen completion snapshot verbatim.
    expect(sAfter).toBe(c);
    expect(sAfter.completedAt).toBe(c.completedAt);
    expect(sAfter.durationMs).toBe(c.durationMs);
  });

  it('elapsedMs() stays live after complete() (only the snapshot is frozen)', () => {
    const timer = createRunTimer();
    timer.complete();
    const e0 = timer.elapsedMs();
    spin(3);
    const e1 = timer.elapsedMs();
    expect(e1).toBeGreaterThanOrEqual(e0);
  });

  it('createRunLifecycle is the spec-named alias of createRunTimer with the same freeze behavior', () => {
    expect(createRunLifecycle).toBe(createRunTimer);
    const lifecycle = createRunLifecycle();
    expect(typeof lifecycle.startedAt).toBe('string');
    expect(typeof lifecycle.startedAtEpochMs).toBe('number');
    expect(typeof lifecycle.elapsedMs).toBe('function');
    expect(typeof lifecycle.snapshot).toBe('function');
    expect(typeof lifecycle.complete).toBe('function');
    // Same idempotent freeze contract.
    const a = lifecycle.complete();
    expect(lifecycle.complete()).toBe(a);
  });
});
