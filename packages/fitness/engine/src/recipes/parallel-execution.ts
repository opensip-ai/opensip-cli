/**
 * @fileoverview Parallel execution engine for fitness recipe checks
 *
 * Runs fitness checks concurrently with configurable parallelism,
 * per-check timeouts, abort support, and retry logic.
 */

import { TimeoutError , logger } from '@opensip-tools/core'

import { memoryProfiler } from '../framework/memory-profiler.js'


import { processSuccessResult, processErrorResult, type ProcessorContext } from './check-result-processor.js'
import { executeWithRetry } from './retry.js'
import { getEffectiveMaxParallel } from './types.js'

import type { FitnessRecipeServiceCallbacks, FitnessRecipeSession } from './service-types.js'
import type { FitnessRecipe } from './types.js'
import type { Check } from '../framework/check-types.js'
import type { CheckResult } from '../types/findings.js'

/** Logger module tag used by every event emitted from the parallel execution engine. */
const MODULE_TAG = 'fitness:execution'

// =============================================================================
// TYPES
// =============================================================================

/** Options for executing a set of fitness checks */
export interface ExecutionOptions {
  checks: Check[]
  cwd: string
  recipe: FitnessRecipe
  /** Per-check pre-resolved file paths from target overrides */
  checkTargetFiles?: ReadonlyMap<string, readonly string[]>
  /**
   * Run-wide globalExcludes from project config. Forwarded into each
   * check's RunOptions so scope-empty checks honor exclusions instead
   * of scanning every file in the prewarmed cache.
   */
  globalExcludes?: readonly string[]
}

/** Service context providing session state, callbacks, and abort control */
export interface ExecutionServiceContext {
  session: FitnessRecipeSession
  callbacks: FitnessRecipeServiceCallbacks
  abortController?: AbortController
  includeViolations?: boolean
}

// =============================================================================
// PARALLEL EXECUTION
// =============================================================================

/** Execute fitness checks concurrently with configurable parallelism and per-check timeouts */
export async function executeParallel(ctx: ExecutionServiceContext, opts: ExecutionOptions): Promise<void> {
  // in-memory: single-threaded Node.js access pattern
  const { checks, cwd, recipe, checkTargetFiles, globalExcludes } = opts
  const { session, callbacks, abortController } = ctx
  const recipeTimeout = recipe.execution.timeout ?? 30_000
  const maxParallel = getEffectiveMaxParallel(recipe)
  const totalChecks = checks.length

  const memoryBeforeMap = new Map<string, number>()
  let nextCheckIndex = 0
  let activeCount = 0
  let shouldStopExecution = false

  const processorCtx: ProcessorContext = { session, callbacks, recipe, includeViolations: ctx.includeViolations ?? false }

  // @fitness-ignore-next-line concurrency-safety -- async arrow provides Promise<void> return type for consistency; single-threaded Node.js access pattern
  /* eslint-disable @typescript-eslint/require-await -- callers `await` this; preserving async signature in case future processors become async */
  const processCheckResult = async (
    checkIndex: number,
    checkId: string,
    checkSlug: string,
    checkTags: readonly string[],
    result: CheckResult,
    durationMs: number,
  ): Promise<void> => {
    // in-memory: single-threaded Node.js access pattern
    const memoryBeforeMB = memoryBeforeMap.get(checkId) ?? 0
    const output = processSuccessResult(processorCtx, {
      checkId,
      checkSlug,
      tags: checkTags,
      checkIndex,
      totalChecks,
      result,
      durationMs,
      memoryBeforeMB,
    })
    if (output.shouldStop) shouldStopExecution = true
  }
  /* eslint-enable @typescript-eslint/require-await */

  const processCheckError = (
    checkIndex: number,
    checkId: string,
    checkSlug: string,
    error: unknown,
    durationMs: number,
    timedOut = false,
    timeoutMs?: number,
  ): void => {
    const memoryBeforeMB = memoryBeforeMap.get(checkId) ?? 0
    const errorInput = {
      checkId,
      checkSlug,
      checkIndex,
      totalChecks,
      error,
      durationMs,
      memoryBeforeMB,
      timedOut,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
    const output = processErrorResult(processorCtx, errorInput)
    if (output.shouldStop) shouldStopExecution = true
  }

  await new Promise<void>((resolve) => {
    const advanceWindow = () => {
      activeCount--

      if (!shouldStopExecution && nextCheckIndex < checks.length && !abortController?.signal.aborted) {
        const nextCheck = checks[nextCheckIndex]
        if (nextCheck) {
          nextCheckIndex++
          startCheck(nextCheck, nextCheckIndex)
        }
      }

      if (activeCount === 0 && (nextCheckIndex >= checks.length || shouldStopExecution)) {
        resolve()
      }
    }

    // @fitness-ignore-next-line file-length-limits -- Parallel check launcher: orchestrates timeout, retry, result processing, and window advancement in a single cohesive unit
    const startCheck = (check: Check, displayIndex: number) => {
      // in-memory: single-threaded Node.js access pattern
      const checkId = check.config.id
      activeCount++

      const checkTimeout = check.config.timeout ?? recipeTimeout
      memoryBeforeMap.set(checkId, memoryProfiler.recordCheckStart())
      callbacks.onCheckStart?.(check.config.slug, displayIndex, totalChecks)
      logger.info({ evt: 'fitness.check.start', module: MODULE_TAG, checkSlug: check.config.slug, index: displayIndex, total: totalChecks, timeoutMs: checkTimeout })

      const startTime = Date.now()
      const checkAbortController = new AbortController()
      const timeoutId = setTimeout(() => checkAbortController.abort(), checkTimeout)

      const targetFiles = checkTargetFiles?.get(check.config.slug)
      void executeWithRetry(() => check.run(cwd, {
        signal: checkAbortController.signal,
        ...(targetFiles ? { targetFiles } : {}),
        ...(globalExcludes ? { globalExcludes } : {}),
      }), {
        enabled: recipe.execution.retryOnFailure ?? false,
        maxRetries: recipe.execution.maxRetries ?? 2,
        checkId,
        checkSlug: check.config.slug,
      })
        .then(async (retryResult) => {
          const durationMs = Date.now() - startTime

          if (retryResult.result === undefined) {
            clearTimeout(timeoutId)
            const isTimeout = checkAbortController.signal.aborted
            logger.info({ evt: 'fitness.check.error', module: MODULE_TAG, checkSlug: check.config.slug, durationMs, timedOut: isTimeout, error: retryResult.lastError instanceof Error ? retryResult.lastError.message : String(retryResult.lastError) })
            void processCheckError(
              displayIndex,
              checkId,
              check.config.slug,
              retryResult.lastError,
              durationMs,
              isTimeout,
              isTimeout ? checkTimeout : undefined,
            )
          /* v8 ignore start -- defensive: when retry returns a defined result the abort signal cannot have fired between fn() resolution and this branch (Promise resolution is microtask-synchronous). Practically unreachable. */
          } else if (checkAbortController.signal.aborted) {
            clearTimeout(timeoutId)
            logger.info({ evt: 'fitness.check.timeout', module: MODULE_TAG, checkSlug: check.config.slug, durationMs, timeoutMs: checkTimeout })
            void processCheckError(
              displayIndex,
              checkId,
              check.config.slug,
              new TimeoutError(`Check ${checkId} timed out after ${checkTimeout}ms`, checkTimeout),
              durationMs,
              true,
              checkTimeout,
            )
          /* v8 ignore stop */
          } else {
            clearTimeout(timeoutId)
            logger.info({ evt: 'fitness.check.done', module: MODULE_TAG, checkSlug: check.config.slug, durationMs, signals: retryResult.result.signals.length })
            await processCheckResult(displayIndex, checkId, check.config.slug, check.config.tags ?? [], retryResult.result, durationMs)
          }
        })
        /* v8 ignore start -- defensive: executeWithRetry never throws (always returns RetryResult), and the .then handler's processSuccessResult/processCheckError do not throw. This catch exists as a guardrail only. */
        .catch((error: unknown) => {
          clearTimeout(timeoutId)
          const durationMs = Date.now() - startTime
          logger.info({ evt: 'fitness.check.error', module: MODULE_TAG, checkSlug: check.config.slug, durationMs, error: error instanceof Error ? error.message : String(error) })
          void processCheckError(displayIndex, checkId, check.config.slug, error, durationMs)
        })
        /* v8 ignore stop */
        .finally(() => advanceWindow())
    }

    const initialBatchSize = Math.min(maxParallel, checks.length)
    for (let i = 0; i < initialBatchSize; i++) {
      const check = checks[i]
      if (check) {
        nextCheckIndex = i + 1
        startCheck(check, i + 1)
      }
    }

    if (checks.length === 0) resolve()
  })
}
