/**
 * @fileoverview Per-check execution lifecycle
 *
 * `runOneCheck` is the single entry point for "run this Check, with its
 * timeout, retry, and abort behavior, and tell me how it ended." Both
 * the parallel and sequential schedulers delegate to it; they keep only
 * the scheduling shape (sliding window vs `for-of` loop).
 *
 * Reconciled abort semantics:
 *
 * The earlier parallel/sequential implementations diverged on how they
 * detected a timeout — parallel inspected `signal.aborted` after the
 * retry resolved; sequential maintained a separate `timedOut` flag
 * mutated by the setTimeout callback. Either signal source is sufficient
 * because the per-check `AbortController` is only aborted by the
 * setTimeout we install here. We keep `signal.aborted` as the canonical
 * shape (it is the controller's own state and survives the retry chain
 * without a closure-scoped flag), and treat any post-retry `aborted`
 * signal as a timeout.
 */

import { TimeoutError, logger, runWithTimeout, withSpanAsync } from '@opensip-cli/core';

import { CheckAbortedError } from '../framework/execution-context.js';
import { resolveMemoryProfiler } from '../framework/scope-registry.js';

import {
  processSuccessResult,
  processErrorResult,
  type ProcessorContext,
  type ProcessResultOutput,
} from './check-result-processor.js';

import type { Check } from '../framework/check-types.js';
import type { FileCache } from '../framework/file-cache.js';

/** Logger module tag used by every event emitted from per-check execution. */
const MODULE_TAG = 'fitness:execution';

// =============================================================================
// TYPES
// =============================================================================

/** Per-call options for `runOneCheck`. */
export interface RunOneCheckOptions {
  readonly cwd: string;
  readonly checkIndex: number;
  readonly totalChecks: number;
  readonly recipeTimeoutMs: number;
  readonly retryEnabled: boolean;
  readonly maxRetries: number;
  readonly checkTargetFiles?: ReadonlyMap<string, readonly string[]>;
  readonly globalExcludes?: readonly string[];
  /** Per-service FileCache (for SaaS isolation; forwarded from ExecutionOptions). */
  readonly fileCache?: FileCache;
}

/** Outcome of running a single check. */
export interface RunOneCheckOutcome {
  /**
   * Whether the scheduling layer should stop dispatching further
   * checks. Mirrors the `shouldStop` field on
   * `ProcessResultOutput`; `false` when no result was processed
   * (e.g. nothing to record because the call short-circuited).
   */
  readonly shouldStop: boolean;
  /** Defined when a result was successfully processed (may be a pass or a fail). */
  readonly processOutput?: ProcessResultOutput;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Execute one check end-to-end: build the abort controller, install the
 * timeout, run with retry, then dispatch the result to
 * `processSuccessResult` / `processErrorResult` based on the outcome.
 *
 * Schedulers should call this once per check. The returned
 * `shouldStop` field tells the scheduler whether to break out of its
 * loop (e.g. `recipe.execution.stopOnFirstFailure`).
 */
export async function runOneCheck(
  check: Check,
  opts: RunOneCheckOptions,
  ctx: ProcessorContext,
): Promise<RunOneCheckOutcome> {
  const checkId = check.config.id;
  const checkSlug = check.config.slug;
  const checkTimeout = check.config.timeout ?? opts.recipeTimeoutMs;

  const memoryBeforeMB = resolveMemoryProfiler().recordCheckStart();
  ctx.callbacks.onCheckStart?.(checkSlug, opts.checkIndex, opts.totalChecks);
  logger.info({
    evt: 'fitness.check.start',
    module: MODULE_TAG,
    checkSlug,
    index: opts.checkIndex,
    total: opts.totalChecks,
    timeoutMs: checkTimeout,
  });

  const targetFiles = opts.checkTargetFiles?.get(checkSlug);

  // Run on the shared execution substrate (release 2.13.0, §5.8): per-check
  // timeout/abort + retry. The single-source abort invariant is preserved by
  // `runWithTimeout` — the controller is aborted ONLY by the timeout — so a
  // `timeout` outcome IS a real timeout, exactly as the former inline
  // AbortController+setTimeout body computed it. `CheckAbortedError` is never
  // retried (the timeout abort surfaces as a `timeout` outcome, not a retry).
  const outcome = await withSpanAsync(
    'opensip-cli-fitness',
    'fitness.check.execute',
    async () => {
      return await runWithTimeout({
        run: (signal) =>
          check.run(opts.cwd, {
            signal,
            ...(targetFiles ? { targetFiles } : {}),
            ...(opts.globalExcludes ? { globalExcludes: opts.globalExcludes } : {}),
            ...(opts.fileCache ? { fileCache: opts.fileCache } : {}),
          }),
        timeoutMs: checkTimeout,
        retry: {
          enabled: opts.retryEnabled,
          maxRetries: opts.maxRetries,
          shouldNotRetry: (error) => error instanceof CheckAbortedError,
        },
      });
    },
    {
      'fitness.check.slug': checkSlug,
      'fitness.check.id': checkId,
      'fitness.check.timeout_ms': checkTimeout,
    },
  );
  const { durationMs } = outcome;

  // The result PROCESSING (which fires user callbacks like onCheckComplete) is
  // wrapped so a throw from a callback is recovered into a non-timeout error
  // result — the same recovery the former inline try/catch provided (pinned by
  // run-one-check.test.ts). The unit RUN itself is already classified by
  // `runWithTimeout` above and never throws here.
  try {
    if (outcome.status === 'timeout') {
      logger.info({
        evt: 'fitness.check.timeout',
        module: MODULE_TAG,
        checkSlug,
        durationMs,
        timeoutMs: checkTimeout,
      });
      const processOutput = processErrorResult(ctx, {
        checkId,
        checkSlug,
        checkIndex: opts.checkIndex,
        totalChecks: opts.totalChecks,
        error: new TimeoutError(`Check ${checkId} timed out after ${checkTimeout}ms`, checkTimeout),
        durationMs,
        memoryBeforeMB,
        timedOut: true,
        timeoutMs: checkTimeout,
      });
      return { shouldStop: processOutput.shouldStop, processOutput };
    }

    if (outcome.status === 'error') {
      logger.info({
        evt: 'fitness.check.error',
        module: MODULE_TAG,
        checkSlug,
        durationMs,
        timedOut: false,
        error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      });
      const processOutput = processErrorResult(ctx, {
        checkId,
        checkSlug,
        checkIndex: opts.checkIndex,
        totalChecks: opts.totalChecks,
        error: outcome.error,
        durationMs,
        memoryBeforeMB,
        timedOut: false,
      });
      return { shouldStop: processOutput.shouldStop, processOutput };
    }

    logger.info({
      evt: 'fitness.check.done',
      module: MODULE_TAG,
      checkSlug,
      durationMs,
      signals: outcome.result.signals.length,
    });
    const processOutput = processSuccessResult(ctx, {
      checkId,
      checkSlug,
      tags: check.config.tags ?? [],
      checkIndex: opts.checkIndex,
      totalChecks: opts.totalChecks,
      result: outcome.result,
      durationMs,
      memoryBeforeMB,
    });
    return { shouldStop: processOutput.shouldStop, processOutput };
  } catch (error) {
    // A user callback inside the result processing threw. Recover it into an
    // error result — non-timeout unless the unit itself timed out.
    const isTimeout = outcome.status === 'timeout';
    logger.info({
      evt: 'fitness.check.error',
      module: MODULE_TAG,
      checkSlug,
      durationMs,
      timedOut: isTimeout,
      error: error instanceof Error ? error.message : String(error),
    });
    const processOutput = processErrorResult(ctx, {
      checkId,
      checkSlug,
      checkIndex: opts.checkIndex,
      totalChecks: opts.totalChecks,
      error,
      durationMs,
      memoryBeforeMB,
      timedOut: isTimeout,
      ...(isTimeout ? { timeoutMs: checkTimeout } : {}),
    });
    return { shouldStop: processOutput.shouldStop, processOutput };
  }
}
