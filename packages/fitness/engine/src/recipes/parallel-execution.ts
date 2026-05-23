/**
 * @fileoverview Parallel execution scheduler for fitness recipe checks
 *
 * Maintains a sliding window of `maxParallel` in-flight `runOneCheck`
 * calls. Per-check semantics (timeout, abort, retry, success/error
 * dispatch) live in `runOneCheck`; this file owns only the scheduling
 * shape.
 */

import { runOneCheck } from './run-one-check.js'
import { getEffectiveMaxParallel } from './types.js'

import type { ProcessorContext } from './check-result-processor.js'
import type { FitnessRecipeServiceCallbacks, FitnessRecipeSession } from './service-types.js'
import type { FitnessRecipe } from './types.js'
import type { Check } from '../framework/check-types.js'

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
  const { checks, cwd, recipe, checkTargetFiles, globalExcludes } = opts
  const { session, callbacks, abortController } = ctx
  const recipeTimeout = recipe.execution.timeout ?? 30_000
  const maxParallel = getEffectiveMaxParallel(recipe)
  const totalChecks = checks.length

  if (totalChecks === 0) return

  const processorCtx: ProcessorContext = {
    session,
    callbacks,
    recipe,
    includeViolations: ctx.includeViolations ?? false,
  }

  let nextCheckIndex = 0
  let activeCount = 0
  let shouldStopExecution = false

  await new Promise<void>((resolve) => {
    const launch = (check: Check, displayIndex: number): void => {
      activeCount++
      void runOneCheck(check, {
        cwd,
        checkIndex: displayIndex,
        totalChecks,
        recipeTimeoutMs: recipeTimeout,
        retryEnabled: recipe.execution.retryOnFailure ?? false,
        maxRetries: recipe.execution.maxRetries ?? 2,
        ...(checkTargetFiles ? { checkTargetFiles } : {}),
        ...(globalExcludes ? { globalExcludes } : {}),
      }, processorCtx)
        .then((outcome) => {
          if (outcome.shouldStop) shouldStopExecution = true
        })
        .finally(() => {
          activeCount--

          if (!shouldStopExecution && nextCheckIndex < checks.length && !abortController?.signal.aborted) {
            const nextCheck = checks[nextCheckIndex]
            if (nextCheck) {
              const idx = nextCheckIndex
              nextCheckIndex++
              launch(nextCheck, idx + 1)
            }
          }

          if (activeCount === 0 && (nextCheckIndex >= checks.length || shouldStopExecution)) {
            resolve()
          }
        })
    }

    const initialBatchSize = Math.min(maxParallel, checks.length)
    for (let i = 0; i < initialBatchSize; i++) {
      const check = checks[i]
      if (check) {
        nextCheckIndex = i + 1
        launch(check, i + 1)
      }
    }
  })
}
