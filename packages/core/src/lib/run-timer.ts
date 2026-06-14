/**
 * @fileoverview Host-owned RunTimer primitive (host-owned-run-timing plan).
 *
 * Single source of truth for wall-clock start + monotonic elapsed for the
 * duration of a user-visible CLI tool run. The host (CLI composition root)
 * creates one `RunTimer` early (before tool command handlers and live views)
 * and exposes it (plus the `record` seam) through `ToolCliContext.runSession`.
 *
 * Tools and engines must never capture their own `Date.now` / `new Date` for
 * the generic `StoredSession.timestamp` and `durationMs` columns; only the
 * host timer feeds those. Internal tool timers (per-unit, per-stage, etc.)
 * remain tool-owned for diagnostics.
 *
 * `startedAt` is ISO wall time captured at construction (the user-initiated
 * start). `durationMs` and `completedAt` come from `snapshot()` at record time.
 * Elapsed uses a monotonic clock (`performance.now` when available) to avoid
 * skew on long runs or system clock adjustments.
 */

export interface RunTimingSnapshot {
  /** ISO-8601 timestamp of run start (wall time, captured early by host). */
  readonly startedAt: string;
  /** ISO-8601 timestamp captured at the moment of this snapshot. */
  readonly completedAt: string;
  /** Wall duration in milliseconds (>= 0). */
  readonly durationMs: number;
}

export interface RunTimer {
  /** ISO-8601 timestamp of run start (fixed for the lifetime of this timer). */
  readonly startedAt: string;
  /** Epoch ms at start (for fallback elapsed calculations). */
  readonly startedAtEpochMs: number;

  /**
   * Current elapsed wall time since start, in ms.
   * Uses monotonic source when available; clamped to >= 0.
   */
  elapsedMs(): number;

  /**
   * Capture a point-in-time snapshot for persisting a `StoredSession`.
   * `startedAt` is stable; `completedAt` and `durationMs` reflect now.
   */
  snapshot(): RunTimingSnapshot;
}

/**
 * Create a fresh host-owned run timer.
 *
 * Must be called by the CLI host after `RunScope` is entered (so `runId` etc.
 * are available for logging in Phase 1 wiring) but before any tool work that
 * will be timed.
 */
export function createRunTimer(): RunTimer {
  const startedAt = new Date().toISOString();
  const startedAtEpochMs = Date.now();

  // Prefer a monotonic clock to avoid wall-time skew on long runs.
  // In Node 16.7+ / modern browsers, `performance` is global and provides
  // `performance.now()`. Fall back to Date math if unavailable.
  const perfNow: (() => number) | undefined =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now.bind(performance)
      : undefined;

  const monotonicStart = perfNow ? perfNow() : undefined;

  function elapsedMs(): number {
    let raw: number;
    if (monotonicStart !== undefined && perfNow) {
      raw = perfNow() - monotonicStart;
    } else {
      raw = Date.now() - startedAtEpochMs;
    }
    return Math.max(0, raw);
  }

  return {
    startedAt,
    startedAtEpochMs,
    elapsedMs,
    snapshot(): RunTimingSnapshot {
      const completedAt = new Date().toISOString();
      const durationMs = Math.max(0, elapsedMs());
      return { startedAt, completedAt, durationMs };
    },
  };
}
