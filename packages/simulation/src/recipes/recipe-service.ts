// @fitness-ignore-file correlation-helpers -- uses @opensip-tools/core/logger which provides automatic correlation ID propagation
// @fitness-ignore-file error-handling-suite -- catch blocks delegate errors through established patterns
// @fitness-ignore-file clean-code-naming-quality -- naming conventions follow domain-specific patterns
/**
 * @fileoverview Simulation recipe service
 *
 * Orchestrates multi-scenario recipe execution with sequential/parallel modes,
 * progress callbacks, and result aggregation.
 */

import { logger } from '@opensip-tools/core'
import { generateId } from '@opensip-tools/core'

import { getScenario } from '../framework/define-scenario.js'
import { createEmptyMetrics } from '../framework/result-builder.js'

import { getRecipe } from './recipe-registry.js'
import type {
  SimulationRecipe,
  RecipeSession,
  RecipeResult,
  RecipeTotals,
  ScenarioRunResult,
  RecipeCallbacks,
} from './recipe-types.js'

// =============================================================================
// RECIPE SERVICE
// =============================================================================

/** Orchestrates multi-scenario recipe execution with progress callbacks and result aggregation */
export class RecipeService {
  private readonly callbacks: RecipeCallbacks
  private activeSession: RecipeSession | undefined

  constructor(callbacks: RecipeCallbacks = {}) {
    this.callbacks = callbacks
  }

  /** Return the currently active recipe session, if any */
  getActiveSession(): RecipeSession | undefined {
    return this.activeSession
  }

  /** Look up a recipe by ID or name */
  findRecipe(idOrName: string): SimulationRecipe | undefined {
    return getRecipe(idOrName)
  }

  /**
   * Execute a recipe: run all scenarios with configured execution options.
   */
  async execute(recipe: SimulationRecipe): Promise<RecipeResult> {
    const sessionId = generateId('SES')
    const startTime = Date.now()

    this.activeSession = {
      sessionId,
      recipeId: recipe.id,
      recipeName: recipe.name,
      startedAt: new Date().toISOString(),
      scenarioResults: [],
    }

    try {
      logger.info({
        evt: 'simulation.recipe.start',
        module: 'simulation:recipe',
        recipeId: recipe.id,
        recipeName: recipe.name,
        scenarioCount: recipe.scenarios.length,
        mode: recipe.execution.mode,
      })

      const results: ScenarioRunResult[] = []

      if (recipe.execution.mode === 'parallel') {
        const parallel = await this.executeParallel(recipe)
        results.push(...parallel)
      } else {
        const sequential = await this.executeSequential(recipe)
        results.push(...sequential)
      }

      this.activeSession.scenarioResults = results

      const totals = computeTotals(results)
      const success = totals.failedScenarios === 0

      const result: RecipeResult = {
        recipeId: recipe.id,
        recipeName: recipe.name,
        success,
        scenarioResults: results,
        totals,
        durationMs: Date.now() - startTime,
      }

      logger.info({
        evt: 'simulation.recipe.complete',
        module: 'simulation:recipe',
        recipeId: recipe.id,
        success,
        durationMs: result.durationMs,
        passed: totals.passedScenarios,
        failed: totals.failedScenarios,
      })

      return result
    } finally {
      this.activeSession = undefined
    }
  }

  private async executeSequential(recipe: SimulationRecipe): Promise<ScenarioRunResult[]> {
    const results: ScenarioRunResult[] = []
    const total = recipe.scenarios.length

    for (let i = 0; i < recipe.scenarios.length; i++) {
      const scenarioRef = recipe.scenarios[i]
      if (!scenarioRef) continue
      void this.callbacks.onScenarioStart?.(scenarioRef.scenarioId, i, total)

      const result = await this.runScenario(scenarioRef.scenarioId)

      results.push(result)
      void this.callbacks.onScenarioComplete?.(scenarioRef.scenarioId, result, i, total)

      if (recipe.execution.stopOnFirstFailure && result.status === 'failed') {
        // Skip remaining scenarios
        for (let j = i + 1; j < recipe.scenarios.length; j++) {
          const remaining = recipe.scenarios[j]
          if (remaining) results.push(createSkippedResult(remaining.scenarioId))
        }
        break
      }
    }

    return results
  }

  private async executeParallel(recipe: SimulationRecipe): Promise<ScenarioRunResult[]> {
    const total = recipe.scenarios.length
    const maxParallel = recipe.execution.maxParallel ?? total

    const results: ScenarioRunResult[] = Array.from({ length: total }, (_, i) => {
      const ref = recipe.scenarios[i]
      return createSkippedResult(ref?.scenarioId ?? `unknown-${i}`)
    })

    // Process in batches of maxParallel
    for (let batchStart = 0; batchStart < total; batchStart += maxParallel) {
      const batchEnd = Math.min(batchStart + maxParallel, total)
      const batch = recipe.scenarios.slice(batchStart, batchEnd)

      const promises = batch.map(async (scenarioRef, batchIdx) => {
        const idx = batchStart + batchIdx
        void this.callbacks.onScenarioStart?.(scenarioRef.scenarioId, idx, total)

        const result = await this.runScenario(scenarioRef.scenarioId)

        results[idx] = result
        void this.callbacks.onScenarioComplete?.(scenarioRef.scenarioId, result, idx, total)
      })

      await Promise.all(promises)

      // Check stopOnFirstFailure after each batch completes
      if (recipe.execution.stopOnFirstFailure) {
        const batchResults = results.slice(batchStart, batchEnd)
        const hasFailed = batchResults.some((r) => r.status === 'failed' || r.status === 'error')
        if (hasFailed) break
      }
    }

    return results
  }

  private async runScenario(
    scenarioId: string,
  ): Promise<ScenarioRunResult> {
    const startTime = Date.now()
    const registeredScenario = getScenario(scenarioId)

    if (!registeredScenario) {
      logger.warn({
        evt: 'simulation.recipe.scenario.notfound',
        module: 'simulation:recipe',
        scenarioId,
      })
      return {
        scenarioId,
        scenarioName: scenarioId,
        status: 'error',
        metrics: createEmptyMetrics(),
        signals: [],
        assertionsPassed: 0,
        assertionsFailed: 0,
        durationMs: Date.now() - startTime,
        error: `Scenario '${scenarioId}' not found in registry`,
      }
    }

    try {
      const abortController = new AbortController()
      const executorResult = await registeredScenario.run(abortController.signal)

      return {
        scenarioId,
        scenarioName: registeredScenario.name,
        status: executorResult.passed ? 'passed' : 'failed',
        metrics: executorResult.metrics,
        signals: executorResult.signals,
        assertionsPassed: executorResult.assertions.passed.length,
        assertionsFailed: executorResult.assertions.failed.length,
        durationMs: Date.now() - startTime,
      }
    } catch (err) {
      return {
        scenarioId,
        scenarioName: registeredScenario.name,
        status: 'error',
        metrics: createEmptyMetrics(),
        signals: [],
        assertionsPassed: 0,
        assertionsFailed: 0,
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function createSkippedResult(scenarioId: string): ScenarioRunResult {
  return {
    scenarioId,
    scenarioName: scenarioId,
    status: 'skipped',
    metrics: createEmptyMetrics(),
    signals: [],
    assertionsPassed: 0,
    assertionsFailed: 0,
    durationMs: 0,
  }
}

function computeTotals(results: ScenarioRunResult[]): RecipeTotals {
  let passedScenarios = 0
  let failedScenarios = 0
  let skippedScenarios = 0
  let totalSignals = 0
  let totalAssertionsPassed = 0
  let totalAssertionsFailed = 0

  for (const r of results) {
    switch (r.status) {
      case 'passed':
        passedScenarios++
        break
      case 'failed':
      case 'error':
        failedScenarios++
        break
      case 'skipped':
        skippedScenarios++
        break
    }
    totalSignals += r.signals.length
    totalAssertionsPassed += r.assertionsPassed
    totalAssertionsFailed += r.assertionsFailed
  }

  return {
    totalScenarios: results.length,
    passedScenarios,
    failedScenarios,
    skippedScenarios,
    totalSignals,
    totalAssertionsPassed,
    totalAssertionsFailed,
  }
}
