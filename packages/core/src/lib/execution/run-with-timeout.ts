/**
 * runWithTimeout — the per-unit timeout/abort/retry wrapper of the execution
 * substrate (north-star §5.8, launch).
 *
 * One unit's lifecycle: install an `AbortController` + `setTimeout`, run the
 * domain function under that signal (optionally with retry), and classify the
 * outcome as `ok` / `timeout` / `error`. The single-source abort invariant is
 * preserved from fitness's `runOneCheck`: the controller is aborted ONLY by the
 * timeout, so a post-run `signal.aborted` IS a timeout.
 *
 * This is the shared primitive that makes "a declared `timeout` actually aborts"
 * true in every domain — the §4.3 fix for simulation, whose `runSingle` declared
 * `execution.timeout` but never installed one.
 */

import { runWithRetry, type PipelineRetryOptions } from './retry.js';

/** Result of one unit run. `timeout` and `error` are distinct so callers can map each. */
export type UnitRunOutcome<R> =
  | { readonly status: 'ok'; readonly result: R; readonly durationMs: number }
  | { readonly status: 'timeout'; readonly durationMs: number; readonly timeoutMs: number }
  | { readonly status: 'error'; readonly error: unknown; readonly durationMs: number };

export interface RunWithTimeoutOptions<R> {
  /** The domain run — receives the abort signal the timeout fires on. */
  readonly run: (signal: AbortSignal) => Promise<R>;
  /** Per-unit timeout (ms). A run that exceeds it is aborted → `status:'timeout'`. */
  readonly timeoutMs: number;
  /** Optional retry (fitness); omitted ⇒ the run executes exactly once. */
  readonly retry?: PipelineRetryOptions;
}

/**
 * Run one unit under a timeout, returning a classified outcome (never throws for
 * a domain error — it is returned as `status:'error'`). Mirrors the proven
 * timeout-detection of fitness's `runOneCheck` (clear the timer, then a
 * `signal.aborted` check is canonical-timeout because the controller has a single
 * abort source).
 */
export async function runWithTimeout<R>(
  opts: RunWithTimeoutOptions<R>,
): Promise<UnitRunOutcome<R>> {
  const controller = new AbortController();
  const startTime = Date.now();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);

  const finish = (): number => {
    clearTimeout(timeoutId);
    return Date.now() - startTime;
  };

  try {
    if (opts.retry) {
      const retry = await runWithRetry(() => opts.run(controller.signal), opts.retry);
      const durationMs = finish();
      if (controller.signal.aborted) {
        return { status: 'timeout', durationMs, timeoutMs: opts.timeoutMs };
      }
      if (retry.result === undefined) {
        return { status: 'error', error: retry.lastError, durationMs };
      }
      return { status: 'ok', result: retry.result, durationMs };
    }

    const result = await opts.run(controller.signal);
    const durationMs = finish();
    // A run that resolved AFTER the timeout fired is reported as a timeout
    // (single-source abort invariant), matching fitness's post-run check.
    if (controller.signal.aborted) {
      return { status: 'timeout', durationMs, timeoutMs: opts.timeoutMs };
    }
    return { status: 'ok', result, durationMs };
  } catch (error) {
    const durationMs = finish();
    if (controller.signal.aborted) {
      return { status: 'timeout', durationMs, timeoutMs: opts.timeoutMs };
    }
    return { status: 'error', error, durationMs };
  }
}
