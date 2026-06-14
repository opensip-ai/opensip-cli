/**
 * @fileoverview Host-owned RunTimer / RunLifecycle primitive
 * (host-owned-run-timing plan).
 *
 * Single source of truth for wall-clock start + monotonic elapsed for one
 * user-visible CLI tool run. The host run-lifecycle plane creates one lifecycle
 * inside the selected command action (after `RunScope` entry, before any
 * tool-owned work) and `complete()`s it once the tool handler / live renderer
 * returns its completion data — that frozen snapshot feeds the generic
 * `StoredSession.startedAt` / `completedAt` / `durationMs`.
 *
 * Tools and engines must never capture their own `Date.now` / `new Date` for
 * the generic session timing fields; only the host lifecycle feeds those.
 * Internal tool timers (per-unit, per-stage, etc.) remain tool-owned for
 * diagnostics.
 *
 * `startedAt` is ISO wall time captured at construction. `complete()` is
 * idempotent: the first call freezes `completedAt` + `durationMs`; later calls
 * return the same frozen snapshot. `snapshot()` reads live before completion
 * (for the ticking live display) and the frozen values after. Elapsed uses a
 * monotonic clock (`performance.now` when available) to avoid skew on long runs
 * or system clock adjustments.
 */

export interface RunTimingSnapshot {
  /** ISO-8601 timestamp of run start (wall time, captured early by host). */
  readonly startedAt: string;
  /** ISO-8601 timestamp captured at the moment of this snapshot. */
  readonly completedAt: string;
  /** Wall duration in milliseconds (>= 0). */
  readonly durationMs: number;
}

/**
 * Host-owned run timer: the single source of run start time and wall duration
 * for a tool invocation. Tools read timing through `ToolCliContext.runSession`
 * rather than capturing their own `Date.now()` (see the
 * `no-tool-owned-session-timing` check).
 */
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
   * Capture a point-in-time snapshot. `startedAt` is stable; `completedAt`
   * and `durationMs` reflect now — unless the lifecycle has already been
   * `complete()`d, in which case the frozen completion snapshot is returned.
   */
  snapshot(): RunTimingSnapshot;

  /**
   * Freeze the run lifecycle. Idempotent: the first call captures
   * `completedAt` + `durationMs`; subsequent calls return the same frozen
   * snapshot. The host run-lifecycle plane calls this once the tool handler /
   * live renderer has returned, before host persistence / render / egress.
   */
  complete(): RunTimingSnapshot;
}

/**
 * The run lifecycle object the host owns for a single tool invocation
 * (host-owned-run-timing §6.1). Structurally identical to {@link RunTimer};
 * the alias gives the spec-named type and creator without churning the many
 * existing `RunTimer` references.
 */
export type RunLifecycle = RunTimer;

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
    const raw =
      monotonicStart !== undefined && perfNow
        ? perfNow() - monotonicStart
        : Date.now() - startedAtEpochMs;
    return Math.max(0, raw);
  }

  let frozen: RunTimingSnapshot | undefined;

  function snapshot(): RunTimingSnapshot {
    if (frozen) return frozen;
    return {
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, elapsedMs()),
    };
  }

  function complete(): RunTimingSnapshot {
    // Idempotent: the first completion freezes completedAt + durationMs.
    frozen ??= {
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, elapsedMs()),
    };
    return frozen;
  }

  return {
    startedAt,
    startedAtEpochMs,
    elapsedMs,
    snapshot,
    complete,
  };
}

/**
 * Create a fresh host-owned run lifecycle. Alias of {@link createRunTimer}
 * under the spec-named factory (host-owned-run-timing §6.1).
 */
export const createRunLifecycle: () => RunLifecycle = createRunTimer;
