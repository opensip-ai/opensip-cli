/**
 * @fileoverview Check result processor for fitness recipe execution
 *
 * Processes individual check results (success or error), updates session state,
 * builds check summaries, and determines whether execution should stop.
 */

import { logger , SystemError } from '@opensip-tools/core'

import { memoryProfiler, type CheckMemoryProfile } from '../framework/memory-profiler.js'
import { countErrors, countWarnings } from '../types/severity.js'

import type { CheckSummary, FitnessRecipeServiceCallbacks, FitnessRecipeSession } from './service-types.js'
import type { FitnessRecipe, RecipeCheckResult } from './types.js'
import type { CheckResult } from '../types/findings.js'

// =============================================================================
// TYPES
// =============================================================================

/** Input data for processing a successful check result */
export interface ProcessSuccessInput {
  checkId: string
  checkSlug: string
  tags: readonly string[]
  checkIndex: number
  totalChecks: number
  result: CheckResult
  durationMs: number
  memoryBeforeMB: number
}

/** Input data for processing a failed or timed-out check result */
export interface ProcessErrorInput {
  checkId: string
  checkSlug: string
  checkIndex: number
  totalChecks: number
  error: unknown
  durationMs: number
  memoryBeforeMB: number
  timedOut: boolean
  timeoutMs?: number
}

/** Context required by the result processor (session, callbacks, recipe) */
export interface ProcessorContext {
  session: FitnessRecipeSession
  callbacks: FitnessRecipeServiceCallbacks
  recipe: FitnessRecipe
  includeViolations: boolean
}

/** Output from processing a check result, including whether execution should stop */
export interface ProcessResultOutput {
  checkResult: RecipeCheckResult
  memoryProfile: CheckMemoryProfile
  shouldStop: boolean
}

// =============================================================================
// CHECK SUMMARY BUILDERS
// =============================================================================

/** Build a CheckSummary from a successful check execution */
function createCheckSummary(
  checkId: string,
  checkSlug: string,
  passed: boolean,
  errorCount: number,
  warningCount: number,
  durationMs: number,
  memoryProfile: CheckMemoryProfile,
  ignoredCount = 0,
  filesScanned = 0,
): CheckSummary {
  return {
    checkId,
    checkSlug,
    passed,
    errors: errorCount,
    warnings: warningCount,
    durationMs,
    filesScanned,
    ignoredCount,
    memoryProfile,
  }
}

/** Build a CheckSummary from a failed or errored check execution */
function createErrorSummary(
  checkId: string,
  checkSlug: string,
  durationMs: number,
  memoryProfile: CheckMemoryProfile,
  timedOut: boolean,
  errorMessage: string,
): CheckSummary {
  return {
    checkId,
    checkSlug,
    passed: false,
    errors: 1,
    warnings: 0,
    durationMs,
    filesScanned: 0,
    ignoredCount: 0,
    memoryProfile,
    timedOut,
    errorMessage,
  }
}

// =============================================================================
// SESSION UPDATES
// =============================================================================

function updateSessionForSuccess(
  session: FitnessRecipeSession,
  checkResult: RecipeCheckResult,
  tags: readonly string[],
): void {
  session.checkResults.push(checkResult)
  session.completedChecks++

  if (checkResult.passed) {
    session.passedChecks++
  } else {
    session.failedChecks++
  }

  session.totalErrors += checkResult.errorCount
  session.totalWarnings += checkResult.warningCount
  session.totalIgnored += checkResult.ignoredCount
  for (const tag of tags) {
    session.ignoresByTag.set(tag, (session.ignoresByTag.get(tag) ?? 0) + checkResult.ignoredCount)
  }
}

function updateSessionForError(session: FitnessRecipeSession, checkResult: RecipeCheckResult): void {
  session.checkResults.push(checkResult)
  session.completedChecks++
  session.failedChecks++
  session.totalErrors++
}

// =============================================================================
// MAIN PROCESSORS
// =============================================================================

/** Process a successful check result: update session, invoke callbacks, and determine stop condition */
export function processSuccessResult(
  ctx: ProcessorContext,
  input: ProcessSuccessInput,
): ProcessResultOutput {
  const { checkId, checkSlug, tags, checkIndex, totalChecks, result, durationMs, memoryBeforeMB } =
    input
  const { session, callbacks, recipe } = ctx

  // Apply file filter if set
  let effectiveSignals = result.signals
  if (recipe.fileFilter) {
    effectiveSignals = result.signals.filter(
      (s) => s.code?.file === recipe.fileFilter,
    )
  }
  const signalCount = effectiveSignals.length
  const errorCount = recipe.fileFilter
    ? countErrors(effectiveSignals)
    : result.errors
  const warningCount = recipe.fileFilter
    ? countWarnings(effectiveSignals)
    : result.warnings
  const ignoredCount = result.ignoredCount ?? 0
  const passed = recipe.fileFilter ? errorCount === 0 : result.passed

  const memoryProfile = memoryProfiler.recordCheckComplete(checkId, memoryBeforeMB, signalCount, durationMs)

  /* v8 ignore start -- memory threshold is sized for production-scale (100MB+); not exercised by unit tests that operate on tiny fixture inputs */
  if (memoryProfiler.exceedsThreshold(memoryProfile.memoryDeltaMB)) {
    logger.warn('Check exceeded memory threshold', { evt: 'fitness.check.memory.exceeded', module: 'fitness:recipes', checkId, checkSlug, memoryDeltaMB: memoryProfile.memoryDeltaMB })
    callbacks.onMemoryWarning?.(checkId, memoryProfile)
  }
  /* v8 ignore stop */

  const checkResult: RecipeCheckResult = {
    checkId,
    checkSlug,
    passed,
    violationCount: signalCount,
    errorCount,
    warningCount,
    ignoredCount,
    durationMs,
    totalItems: result.metadata.totalItems,
    itemType: result.metadata.itemType,
    skipped: false,
    ...(result.appliedDirectives && result.appliedDirectives.length > 0
      ? { appliedDirectives: result.appliedDirectives }
      : {}),
    ...(ctx.includeViolations ? {
      violations: effectiveSignals.map((s) => ({
        file: s.code?.file ?? 'unknown',
        line: s.code?.line ?? 0,
        column: s.code?.column,
        message: s.message,
        severity: s.severity === 'high' ? 'error' as const : 'warning' as const,
        suggestion: s.suggestion,
      })),
    } : {}),
  }

  updateSessionForSuccess(session, checkResult, tags)

  const summary = createCheckSummary(checkId, checkSlug, passed, errorCount, warningCount, durationMs, memoryProfile, ignoredCount, result.metadata.filesScanned ?? 0)
  callbacks.onCheckComplete?.(checkSlug, summary, checkIndex, totalChecks)

  const shouldStop = recipe.execution.stopOnFirstFailure && !passed

  return { checkResult, memoryProfile, shouldStop }
}

/** Process a failed check result: update session, invoke callbacks, and determine stop condition */
export function processErrorResult(ctx: ProcessorContext, input: ProcessErrorInput): ProcessResultOutput {
  const { checkId, checkSlug, checkIndex, totalChecks, error, durationMs, memoryBeforeMB, timedOut, timeoutMs } = input
  const { session, callbacks, recipe } = ctx

  let errMsg: string
  if (timedOut && timeoutMs) {
    errMsg = `Check ${checkSlug} timed out after ${timeoutMs}ms`
  } else {
    /* v8 ignore next -- callers always pass Error subclasses; the String(error) fallback is defensive */
    errMsg = error instanceof Error ? error.message : String(error)
  }

  const memoryProfile = memoryProfiler.recordCheckComplete(checkId, memoryBeforeMB, 0, durationMs)

  const checkResult: RecipeCheckResult = {
    checkId,
    checkSlug,
    passed: false,
    violationCount: 0,
    errorCount: 1,
    warningCount: 0,
    ignoredCount: 0,
    durationMs,
    skipped: false,
    error: errMsg,
    timedOut,
  }

  updateSessionForError(session, checkResult)

  const summary = createErrorSummary(checkId, checkSlug, durationMs, memoryProfile, timedOut, errMsg)
  callbacks.onError?.(checkSlug, error instanceof Error ? error : new SystemError(errMsg, { code: 'SYSTEM.FITNESS.CHECK_ERROR' }))
  callbacks.onCheckComplete?.(checkSlug, summary, checkIndex, totalChecks)

  const shouldStop = recipe.execution.stopOnFirstFailure

  return { checkResult, memoryProfile, shouldStop }
}
