/**
 * @fileoverview Sequential execution engine for fitness recipe checks
 *
 * Runs fitness checks one at a time with per-check timeouts,
 * abort support, and retry logic.
 */

import { TimeoutError } from '@opensip-tools/core'

import { memoryProfiler } from '../framework/memory-profiler.js'

import {
  processSuccessResult,
  processErrorResult,
  type ProcessorContext,
} from './check-result-processor.js'
import { executeWithRetry } from './retry.js'

import type { ExecutionOptions, ExecutionServiceContext } from './parallel-execution.js'

// =============================================================================
// SEQUENTIAL EXECUTION
// =============================================================================

/** Execute fitness checks sequentially with per-check timeouts and retry support */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Inherent complexity: sequential check execution with per-check timeouts, abort signal handling, file matching, error recovery, and progress callbacks
export async function executeSequential(ctx: ExecutionServiceContext, opts: ExecutionOptions): Promise<void> {
  const { checks, cwd, recipe, checkTargetFiles, globalExcludes } = opts
  const { session, callbacks, abortController } = ctx
  const recipeTimeout = recipe.execution.timeout ?? 30_000
  const totalChecks = checks.length

  const processorCtx: ProcessorContext = { session, callbacks, recipe, includeViolations: ctx.includeViolations ?? false }

  // @fitness-ignore-next-line file-length-limits -- Sequential check execution loop: orchestrates check lifecycle (start, run, retry, complete) callbacks
  for (const [i, check] of checks.entries()) {
    if (abortController?.signal.aborted) break

    if (!check) continue

    const checkId = check.config.id
    const checkSlug = check.config.slug
    const timeout = check.config.timeout ?? recipeTimeout

    void callbacks.onCheckStart?.(checkSlug, i + 1, totalChecks)

    const checkAbortController = new AbortController()
    const memoryBeforeMB = memoryProfiler.recordCheckStart()
    const startTime = Date.now()
    let timedOut = false

    const timeoutId = setTimeout(() => {
      timedOut = true
      checkAbortController.abort()
    }, timeout)

    try {
      const retryResult = await executeWithRetry(
        () => {
          const targetFiles = checkTargetFiles?.get(check.config.slug)
          return check.run(cwd, {
            signal: checkAbortController.signal,
            ...(targetFiles ? { targetFiles } : {}),
            ...(globalExcludes ? { globalExcludes } : {}),
          })
        },
        {
          enabled: recipe.execution.retryOnFailure ?? false,
          maxRetries: recipe.execution.maxRetries ?? 2,
          checkId,
          checkSlug,
        },
      )
      clearTimeout(timeoutId)

      if (checkAbortController.signal.aborted) {
        const durationMs = Date.now() - startTime
        const output = processErrorResult(processorCtx, {
          checkId,
          checkSlug,
          checkIndex: i + 1,
          totalChecks,
          error: new TimeoutError(`Check ${checkId} timed out after ${timeout}ms`, timeout),
          durationMs,
          memoryBeforeMB,
          timedOut: true,
          timeoutMs: timeout,
        })
        if (output.shouldStop) break
        continue
      }

      if (retryResult.result === undefined) {
        const durationMs = Date.now() - startTime
        const output = processErrorResult(processorCtx, {
          checkId,
          checkSlug,
          checkIndex: i + 1,
          totalChecks,
          error: retryResult.lastError,
          durationMs,
          memoryBeforeMB,
          timedOut: false,
        })
        if (output.shouldStop) break
        continue
      }

      const durationMs = Date.now() - startTime
      const output = processSuccessResult(processorCtx, {
        checkId,
        checkSlug,
        tags: check.config.tags ?? [],
        checkIndex: i + 1,
        totalChecks,
        result: retryResult.result,
        durationMs,
        memoryBeforeMB,
      })
      if (output.shouldStop) break
    } catch (error) {
      clearTimeout(timeoutId)
      const durationMs = Date.now() - startTime
      const isTimeout = timedOut || checkAbortController.signal.aborted
      const output = processErrorResult(processorCtx, {
        checkId,
        checkSlug,
        checkIndex: i + 1,
        totalChecks,
        error,
        durationMs,
        memoryBeforeMB,
        timedOut: isTimeout,
        ...(isTimeout ? { timeoutMs: timeout } : {}),
      })
      if (output.shouldStop) break
    }
  }
}
