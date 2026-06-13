/**
 * scheduleUnits — the bounded scheduler of the execution substrate (north-star
 * §5.8, launch).
 *
 * Owns the scheduling SHAPE — a `parallel` sliding window bounded by `maxParallel`,
 * or a `sequential` one-at-a-time loop — plus the stop policy and an external
 * abort check. The per-unit lifecycle (timeout/retry/result) is the caller's
 * `runUnit`, which returns whether scheduling should stop (the domain's
 * `stopOnFirstFailure` decision). This is the one loop fit + sim run on, replacing
 * their hand-rolled parallel pools and `for-of` loops (the `same-recipe-semantics`
 * guarantee).
 *
 * Faithfully generalized from fitness's `executeParallel` (sliding window: launch
 * up to `maxParallel`, refill on each completion unless stopping/aborted, resolve
 * when drained) and `executeSequential` (`for-of`, abort-check at the top, break
 * on stop).
 */

/**
 * Hand control back to the event loop's macrotask queue. `await runUnit()` only
 * yields to the MICROtask queue, so a `setInterval` timer (the 80ms live-progress
 * clock) and Ink's repaint never get a turn between back-to-back synchronous
 * units. A `setImmediate` boundary lets them run — the interim live-view smoothing
 * (the durable fix runs the engine off the main thread; ADR-0016/ADR-0028).
 */
export const yieldToEventLoop = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

export interface ScheduleUnitsOptions<Unit> {
  readonly units: readonly Unit[];
  readonly mode: 'parallel' | 'sequential';
  /** Concurrency bound in `parallel` mode (ignored for `sequential`). Default 1. */
  readonly maxParallel?: number;
  /**
   * Run one unit (its full timeout/retry/result lifecycle) and report whether the
   * scheduler should stop launching further units. Receives the 0-based index.
   */
  readonly runUnit: (unit: Unit, index: number) => Promise<{ readonly shouldStop: boolean }>;
  /** External abort check (e.g. a service-level AbortController); polled before each launch. */
  readonly shouldAbort?: () => boolean;
  /**
   * When true, insert a macrotask boundary ({@link yieldToEventLoop}) after each
   * unit completes, so a live-progress timer + renderer on the same thread can
   * paint between units. Opt-in (default off) — only the interactive (TTY) run
   * paths set it; `--json`/non-TTY callers don't need it.
   */
  readonly yieldBetweenUnits?: boolean;
}

/** Schedule `units` through `runUnit` per the mode/concurrency/stop policy. */
export async function scheduleUnits<Unit>(opts: ScheduleUnitsOptions<Unit>): Promise<void> {
  const { units, mode, shouldAbort } = opts;
  if (units.length === 0) return;

  // Each unit's promise resolves AFTER a macrotask yield when requested, so a
  // same-thread live-progress timer + renderer paint between units. Wrapping
  // `runUnit` (rather than the scheduling logic) keeps the parallel sliding
  // window's activeCount/relaunch bookkeeping synchronous and correct in both modes.
  const runUnit: ScheduleUnitsOptions<Unit>['runUnit'] =
    opts.yieldBetweenUnits === true
      ? async (unit, index) => {
          // @fitness-ignore-next-line async-waterfall-detection -- deliberately sequential: the macrotask yield MUST run AFTER the unit completes (it is the between-units boundary); parallelizing with Promise.all would defeat the purpose.
          const outcome = await opts.runUnit(unit, index);
          await yieldToEventLoop();
          return outcome;
        }
      : opts.runUnit;

  if (mode === 'sequential') {
    for (const [index, unit] of units.entries()) {
      if (shouldAbort?.() === true) break;
      const { shouldStop } = await runUnit(unit, index);
      if (shouldStop) break;
    }
    return;
  }

  // Parallel sliding window — mirrors fitness's executeParallel.
  const maxParallel = Math.max(1, opts.maxParallel ?? 1);
  let nextIndex = 0;
  let activeCount = 0;
  let stopping = false;

  await new Promise<void>((resolve) => {
    const launch = (unit: Unit, index: number): void => {
      activeCount++;
      void runUnit(unit, index)
        .then(({ shouldStop }) => {
          if (shouldStop) stopping = true;
        })
        .finally(() => {
          activeCount--;
          if (!stopping && nextIndex < units.length && shouldAbort?.() !== true) {
            const next = units[nextIndex];
            if (next !== undefined) {
              const idx = nextIndex;
              nextIndex++;
              launch(next, idx);
            }
          }
          if (activeCount === 0 && (nextIndex >= units.length || stopping)) {
            resolve();
          }
        });
    };

    const initialBatch = Math.min(maxParallel, units.length);
    for (let i = 0; i < initialBatch; i++) {
      const unit = units[i];
      if (unit !== undefined) {
        nextIndex = i + 1;
        launch(unit, i);
      }
    }
  });
}
