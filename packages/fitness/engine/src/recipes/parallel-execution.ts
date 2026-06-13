/**
 * @fileoverview Parallel execution scheduler for fitness recipe checks
 *
 * Maintains a sliding window of `maxParallel` in-flight `runOneCheck`
 * calls. Per-check semantics (timeout, abort, retry, success/error
 * dispatch) live in `runOneCheck`; this file owns only the scheduling
 * shape.
 */

import { scheduleUnits } from '@opensip-cli/core';

import { runOneCheck } from './run-one-check.js';
import { getEffectiveMaxParallel } from './types.js';

import type { ProcessorContext } from './check-result-processor.js';
import type { FitnessRecipeServiceCallbacks, FitnessRecipeSession } from './service-types.js';
import type { FitnessRecipe } from './types.js';
import type { Check } from '../framework/check-types.js';
import type { FileCache } from '../framework/file-cache.js';

// =============================================================================
// TYPES
// =============================================================================

/** Options for executing a set of fitness checks */
export interface ExecutionOptions {
  checks: Check[];
  cwd: string;
  recipe: FitnessRecipe;
  /** Per-check pre-resolved file paths from target overrides */
  checkTargetFiles?: ReadonlyMap<string, readonly string[]>;
  /**
   * Run-wide globalExcludes from project config. Forwarded into each
   * check's RunOptions so scope-empty checks honor exclusions instead
   * of scanning every file in the prewarmed cache.
   */
  globalExcludes?: readonly string[];
  /** Per-service FileCache (for concurrent SaaS RunScope isolation). */
  fileCache?: FileCache;
}

/** Service context providing session state, callbacks, and abort control */
export interface ExecutionServiceContext {
  session: FitnessRecipeSession;
  callbacks: FitnessRecipeServiceCallbacks;
  abortController?: AbortController;
  includeViolations?: boolean;
}

// =============================================================================
// PARALLEL EXECUTION
// =============================================================================

/** Execute fitness checks concurrently with configurable parallelism and per-check timeouts */
export async function executeParallel(
  ctx: ExecutionServiceContext,
  opts: ExecutionOptions,
): Promise<void> {
  const { checks, cwd, recipe, checkTargetFiles, globalExcludes } = opts;
  const { session, callbacks, abortController } = ctx;
  const recipeTimeout = recipe.execution.timeout ?? 30_000;
  const maxParallel = getEffectiveMaxParallel(recipe);
  const totalChecks = checks.length;

  if (totalChecks === 0) return;

  const processorCtx: ProcessorContext = {
    session,
    callbacks,
    recipe,
    includeViolations: ctx.includeViolations ?? false,
  };

  // Release 2.13.0 (§5.8): the sliding-window scheduling shape now lives in the
  // shared substrate (`scheduleUnits`). This file keeps only the fitness setup +
  // the per-check `runOneCheck` body; the loop/concurrency/stop/abort policy is
  // host-owned. Byte-identical: scheduleUnits launches units in array order
  // (1-based `index + 1` = the former `displayIndex`), refills up to `maxParallel`
  // unless stopping/aborted, and resolves when drained.
  await scheduleUnits<Check>({
    units: checks,
    mode: 'parallel',
    maxParallel,
    // Interim live-view smoothing (ADR-0028): a macrotask boundary between checks
    // lets the in-process live spinner + 80ms clock paint. Superseded for the
    // live run by off-main-thread execution; harmless on the --json path.
    yieldBetweenUnits: true,
    shouldAbort: () => abortController?.signal.aborted === true,
    runUnit: async (check, index) => {
      const outcome = await runOneCheck(
        check,
        {
          cwd,
          checkIndex: index + 1,
          totalChecks,
          recipeTimeoutMs: recipeTimeout,
          retryEnabled: recipe.execution.retryOnFailure ?? false,
          maxRetries: recipe.execution.maxRetries ?? 2,
          ...(checkTargetFiles ? { checkTargetFiles } : {}),
          ...(globalExcludes ? { globalExcludes } : {}),
        },
        processorCtx,
      );
      return { shouldStop: outcome.shouldStop };
    },
  });
}
