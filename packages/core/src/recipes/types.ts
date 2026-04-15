// @fitness-ignore-file module-coupling-metrics -- type definition module: exports are related interfaces/types for the recipe execution domain
/**
 * @fileoverview Core types for fitness recipes
 *
 * Defines FitnessRecipe, CheckSelector, RecipeCheckResult, and related
 * types used throughout the recipe execution system.
 */

import os from 'node:os'

import type { DirectiveEntry } from '../framework/directive-inventory.js'

// =============================================================================
// CHECK SELECTOR TYPES
// =============================================================================

/** Selector that specifies checks by explicit slug list */
export interface ExplicitCheckSelector {
  readonly type: 'explicit'
  readonly checkIds: readonly string[]
}

/** Selector that matches checks via glob patterns */
export interface PatternCheckSelector {
  readonly type: 'pattern'
  readonly include: readonly string[]
  readonly exclude?: readonly string[]
}

/** Selector that includes all checks with specified tags */
export interface TagsCheckSelector {
  readonly type: 'tags'
  readonly include: readonly string[]
  readonly exclude?: readonly string[]
}

/** Selector that includes all checks with optional exclusions */
export interface AllCheckSelector {
  readonly type: 'all'
  readonly exclude?: readonly string[]
}

/** Union of all check selector types used by recipes */
export type CheckSelector =
  | ExplicitCheckSelector
  | PatternCheckSelector
  | TagsCheckSelector
  | AllCheckSelector

// =============================================================================
// EXECUTION OPTIONS
// =============================================================================

/** Execution configuration for a fitness recipe */
export interface FitnessExecutionOptions {
  readonly mode: 'parallel' | 'sequential'
  readonly stopOnFirstFailure: boolean
  readonly timeout?: number
  readonly maxParallel?: number
  readonly retryOnFailure?: boolean
  readonly maxRetries?: number
  readonly successThreshold?: number
}

// =============================================================================
// REPORTING OPTIONS
// =============================================================================

/** Reporting output configuration for a fitness recipe */
export interface FitnessReportingOptions {
  readonly format: 'table' | 'json' | 'unified'
  readonly verbose: boolean
  readonly outputPath?: string
}

// =============================================================================
// FITNESS RECIPE
// =============================================================================

/** Complete recipe definition: checks, execution, and reporting */
export interface FitnessRecipe {
  readonly id: string
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly checks: CheckSelector
  readonly execution: FitnessExecutionOptions
  readonly reporting: FitnessReportingOptions
  readonly tags?: readonly string[]
  readonly includeDisabled?: readonly string[]
  readonly fileFilter?: string
}

// =============================================================================
// RECIPE RUN RESULT
// =============================================================================

/** A single violation detail from a fitness check. */
export interface RecipeViolation {
  readonly file: string
  readonly line: number
  readonly column?: number
  readonly message: string
  readonly severity: 'error' | 'warning'
  readonly suggestion?: string
}

/** Result of a single check within a recipe execution */
export interface RecipeCheckResult {
  readonly checkId: string
  readonly checkSlug: string
  readonly passed: boolean
  readonly violationCount: number
  readonly errorCount: number
  readonly warningCount: number
  readonly ignoredCount: number
  readonly durationMs: number
  readonly totalItems?: number | undefined
  readonly itemType?: string | undefined
  readonly skipped: boolean
  readonly skipReason?: string
  readonly error?: string
  readonly timedOut?: boolean
  appliedDirectives?: readonly import('../framework/directive-inventory.js').DirectiveEntry[] | undefined
  /** Violation details. Populated when includeViolations is true. */
  readonly violations?: readonly RecipeViolation[]
}

/** Aggregated summary of a complete recipe run */
export interface RecipeRunSummary {
  readonly totalChecks: number
  readonly passedChecks: number
  readonly failedChecks: number
  readonly skippedChecks: number
  readonly erroredChecks: number
  readonly totalViolations: number
  readonly totalErrors: number
  readonly totalWarnings: number
  readonly totalIgnored: number
}

/** Ignore directive counts by type. */
export interface IgnoresByType {
  file: number
  line: number
  block: number
  total: number
}

/** Complete result of a recipe execution including all check results and summary */
export interface FitnessRecipeResult {
  readonly recipeId: string
  readonly recipeName: string
  readonly sessionId: string
  readonly success: boolean
  readonly startedAt: Date
  readonly completedAt: Date
  readonly durationMs: number
  readonly checkResults: readonly RecipeCheckResult[]
  readonly summary: RecipeRunSummary
  readonly ignoreCounts?: IgnoresByType | undefined
  readonly directives?: readonly DirectiveEntry[] | undefined
}

// =============================================================================
// RECIPE BUILDER HELPERS
// =============================================================================

/** Input definition used by defineRecipe() to create a FitnessRecipe */
export interface FitnessRecipeDefinition {
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly checks: CheckSelector
  readonly execution?: Partial<FitnessExecutionOptions>
  readonly reporting?: Partial<FitnessReportingOptions>
  readonly tags?: readonly string[]
  readonly includeDisabled?: readonly string[]
}

/** Default maximum parallelism based on available CPU cores */
export const DEFAULT_MAX_PARALLEL = os.availableParallelism?.() ?? os.cpus().length

/** Default execution options applied when not overridden by a recipe */
export const DEFAULT_EXECUTION_OPTIONS: FitnessExecutionOptions = {
  mode: 'parallel',
  stopOnFirstFailure: false,
  timeout: 30_000,
  maxParallel: DEFAULT_MAX_PARALLEL,
} as const

/** Return the effective max parallelism for a recipe, falling back to the system default */
export function getEffectiveMaxParallel(recipe: FitnessRecipe): number {
  return recipe.execution.maxParallel ?? DEFAULT_MAX_PARALLEL
}

/** Default reporting options applied when not overridden by a recipe */
export const DEFAULT_REPORTING_OPTIONS: FitnessReportingOptions = {
  format: 'table',
  verbose: false,
} as const

/** Create a frozen FitnessRecipe from a definition, applying defaults for missing options */
export function defineRecipe(definition: FitnessRecipeDefinition): FitnessRecipe {
  const id = `RCP_${definition.name}`

  const recipe: FitnessRecipe = {
    id,
    name: definition.name,
    displayName: definition.displayName,
    description: definition.description,
    checks: definition.checks,
    execution: {
      ...DEFAULT_EXECUTION_OPTIONS,
      ...definition.execution,
    },
    reporting: {
      ...DEFAULT_REPORTING_OPTIONS,
      ...definition.reporting,
    },
  }

  if (definition.tags || definition.includeDisabled) {
    return Object.freeze({
      ...recipe,
      ...(definition.tags ? { tags: definition.tags } : {}),
      ...(definition.includeDisabled ? { includeDisabled: definition.includeDisabled } : {}),
    })
  }

  return Object.freeze(recipe)
}

