/**
 * @fileoverview Sequential execution scheduler for fitness recipe checks
 *
 * Runs fitness checks one at a time. Release 2.13.0 (§5.8): the loop + the
 * between-iteration abort check now live in the shared execution substrate
 * (`scheduleUnits`); this file keeps only the fitness setup + the per-check
 * `runOneCheck` body.
 */

import { scheduleUnits } from '@opensip-tools/core'

import { runOneCheck } from './run-one-check.js'

import type { ProcessorContext } from './check-result-processor.js'
import type { ExecutionOptions, ExecutionServiceContext } from './parallel-execution.js'
import type { Check } from '../framework/check-types.js'

// =============================================================================
// SEQUENTIAL EXECUTION
// =============================================================================

/** Execute fitness checks sequentially with per-check timeouts and retry support */
export async function executeSequential(ctx: ExecutionServiceContext, opts: ExecutionOptions): Promise<void> {
  const { checks, cwd, recipe, checkTargetFiles, globalExcludes } = opts
  const { session, callbacks, abortController } = ctx
  const recipeTimeout = recipe.execution.timeout ?? 30_000
  const totalChecks = checks.length

  const processorCtx: ProcessorContext = {
    session,
    callbacks,
    recipe,
    includeViolations: ctx.includeViolations ?? false,
  }

  await scheduleUnits<Check>({
    units: checks,
    mode: 'sequential',
    shouldAbort: () => abortController?.signal.aborted === true,
    runUnit: async (check, index) => {
      const outcome = await runOneCheck(check, {
        cwd,
        checkIndex: index + 1,
        totalChecks,
        recipeTimeoutMs: recipeTimeout,
        retryEnabled: recipe.execution.retryOnFailure ?? false,
        maxRetries: recipe.execution.maxRetries ?? 2,
        ...(checkTargetFiles ? { checkTargetFiles } : {}),
        ...(globalExcludes ? { globalExcludes } : {}),
      }, processorCtx)
      return { shouldStop: outcome.shouldStop }
    },
  })
}
