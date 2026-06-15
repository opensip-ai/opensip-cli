/**
 * executePipeline — the `ExecutionPipeline<Unit, Result>` of north-star §5.8: the
 * convenience combinator over {@link scheduleUnits} (the bounded loop) and
 * {@link runWithTimeout} (the per-unit timeout/retry wrapper).
 *
 * A tool supplies only a `runOne` (the domain run) and an `onResult` mapper (turn
 * a classified `UnitRunOutcome` into its domain result + the stop decision); the
 * substrate owns the loop, concurrency, timeout/abort, retry, and stop policy.
 * `WorkflowExecutionOptions` (`timeout`/`maxParallel`/`stopOnFirstFailure`/`retry`)
 * therefore mean the same thing in every domain.
 *
 * Tools with a richer per-unit lifecycle (fitness threads memory profiling +
 * callbacks through its own `runOneCheck`) may compose `scheduleUnits` +
 * `runWithTimeout` directly instead; both routes are "on the substrate".
 */

import { runWithTimeout, type UnitRunOutcome } from './run-with-timeout.js';
import { scheduleUnits } from './schedule.js';

import type { WorkflowExecutionOptions } from './options.js';

/** Default per-unit timeout when a recipe declares none (fitness's historical 30s). */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ExecutePipelineOptions<Unit, R> {
  readonly units: readonly Unit[];
  readonly options: WorkflowExecutionOptions;
  /** The domain run for one unit, under the substrate's abort signal. */
  readonly runOne: (unit: Unit, signal: AbortSignal) => Promise<R>;
  /** Map a classified outcome to a domain result + whether to stop scheduling. */
  readonly onResult: (
    unit: Unit,
    index: number,
    outcome: UnitRunOutcome<R>,
  ) => { readonly shouldStop: boolean } | Promise<{ readonly shouldStop: boolean }>;
  /** Per-unit timeout override (falls back to `options.timeout`, then 30s). */
  readonly timeoutFor?: (unit: Unit) => number | undefined;
  /** External abort check threaded into the scheduler. */
  readonly shouldAbort?: () => boolean;
}

/** Run `units` on the substrate: scheduled, timed out, retried, and stop-policied. */
export async function executePipeline<Unit, R>(
  opts: ExecutePipelineOptions<Unit, R>,
): Promise<void> {
  await scheduleUnits<Unit>({
    units: opts.units,
    mode: opts.options.mode,
    ...(opts.options.maxParallel === undefined ? {} : { maxParallel: opts.options.maxParallel }),
    ...(opts.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}),
    runUnit: async (unit, index) => {
      const timeoutMs = opts.timeoutFor?.(unit) ?? opts.options.timeout ?? DEFAULT_TIMEOUT_MS;
      const outcome = await runWithTimeout({
        run: (signal) => opts.runOne(unit, signal),
        timeoutMs,
        ...(opts.options.retry ? { retry: { ...opts.options.retry } } : {}),
      });
      return opts.onResult(unit, index, outcome);
    },
  });
}
