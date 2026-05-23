/**
 * @fileoverview Sequential execution scheduler for fitness recipe checks
 *
 * Runs fitness checks one at a time. Per-check semantics (timeout,
 * abort, retry, success/error dispatch) live in `runOneCheck`; this
 * file owns only the `for-of` loop and the abort-controller check
 * between iterations.
 */

import { runOneCheck } from './run-one-check.js'

import type { ProcessorContext } from './check-result-processor.js'
import type { ExecutionOptions, ExecutionServiceContext } from './parallel-execution.js'

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

  for (const [i, check] of checks.entries()) {
    if (abortController?.signal.aborted) break
    if (!check) continue

    const outcome = await runOneCheck(check, {
      cwd,
      checkIndex: i + 1,
      totalChecks,
      recipeTimeoutMs: recipeTimeout,
      retryEnabled: recipe.execution.retryOnFailure ?? false,
      maxRetries: recipe.execution.maxRetries ?? 2,
      ...(checkTargetFiles ? { checkTargetFiles } : {}),
      ...(globalExcludes ? { globalExcludes } : {}),
    }, processorCtx)

    if (outcome.shouldStop) break
  }
}
