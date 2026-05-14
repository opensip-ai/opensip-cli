/**
 * @fileoverview Simulation recipe types
 *
 * Recipes compose multiple scenarios into a single executable session
 * with execution options, callbacks, and result aggregation.
 */

import type { Signal } from '@opensip-tools/core'

import type { SimulationMetrics } from '../types/base-types.js'

// =============================================================================
// RECIPE DEFINITION
// =============================================================================

/** Reference to a scenario within a recipe, with optional overrides */
export interface RecipeScenario {
  readonly scenarioId: string
  readonly durationOverride?: number
  readonly tags?: readonly string[]
}

/** Complete simulation recipe composing multiple scenarios into a single executable session */
export interface SimulationRecipe {
  readonly id: string
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly scenarios: readonly RecipeScenario[]
  readonly execution: RecipeExecutionOptions
  readonly tags: readonly string[]
}

// =============================================================================
// EXECUTION OPTIONS
// =============================================================================

/** Execution configuration for a simulation recipe */
export interface RecipeExecutionOptions {
  readonly mode: 'sequential' | 'parallel'
  readonly stopOnFirstFailure: boolean
  readonly maxParallel?: number
  readonly timeout?: number
}

// =============================================================================
// SESSION & RESULT TYPES
// =============================================================================

/** Active recipe execution session tracking progress and results */
export interface RecipeSession {
  readonly sessionId: string
  readonly recipeId: string
  readonly recipeName: string
  readonly startedAt: string
  scenarioResults: ScenarioRunResult[]
}

/** Result of a single scenario execution within a recipe */
export interface ScenarioRunResult {
  readonly scenarioId: string
  readonly scenarioName: string
  readonly status: 'passed' | 'failed' | 'skipped' | 'error'
  readonly metrics: SimulationMetrics
  readonly signals: readonly Signal[]
  readonly assertionsPassed: number
  readonly assertionsFailed: number
  readonly durationMs: number
  readonly error?: string
}

/** Complete result of a simulation recipe execution */
export interface RecipeResult {
  readonly recipeId: string
  readonly recipeName: string
  readonly success: boolean
  readonly scenarioResults: readonly ScenarioRunResult[]
  readonly totals: RecipeTotals
  readonly durationMs: number
}

/** Aggregated totals across all scenarios in a recipe run */
export interface RecipeTotals {
  readonly totalScenarios: number
  readonly passedScenarios: number
  readonly failedScenarios: number
  readonly skippedScenarios: number
  readonly totalSignals: number
  readonly totalAssertionsPassed: number
  readonly totalAssertionsFailed: number
}

// =============================================================================
// CALLBACKS
// =============================================================================

/** Callbacks invoked during simulation recipe execution for progress tracking */
export interface RecipeCallbacks {
  onScenarioStart?: (scenarioId: string, index: number, total: number) => void
  onScenarioComplete?: (scenarioId: string, result: ScenarioRunResult, index: number, total: number) => void
}
