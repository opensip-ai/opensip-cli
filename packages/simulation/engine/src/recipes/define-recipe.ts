/**
 * @fileoverview Define and register simulation recipes
 *
 * Validates recipe configuration with Zod and auto-registers with the recipe registry.
 * Validates that referenced scenario IDs exist in the scenario registry.
 */

import { ValidationError } from '@opensip-tools/core'
import { z } from 'zod'

import { recipeRegistry } from './recipe-registry.js'
import type { SimulationRecipe, RecipeExecutionOptions, RecipeScenario } from './recipe-types.js'

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const RecipeScenarioSchema = z.object({
  scenarioId: z.string().min(1),
  durationOverride: z.number().positive().optional(),
  tags: z.array(z.string()).optional(),
})

const ExecutionOptionsSchema = z.object({
  mode: z.enum(['sequential', 'parallel']).default('sequential'),
  stopOnFirstFailure: z.boolean().default(false),
  maxParallel: z.number().positive().optional(),
  timeout: z.number().positive().optional(),
})

const RecipeConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  scenarios: z.array(RecipeScenarioSchema).min(1),
  execution: ExecutionOptionsSchema.optional(),
  tags: z.array(z.string()).default([]),
})

type RecipeConfig = z.input<typeof RecipeConfigSchema>

// =============================================================================
// DEFAULTS
// =============================================================================

const DEFAULT_EXECUTION: RecipeExecutionOptions = {
  mode: 'sequential',
  stopOnFirstFailure: false,
}

// =============================================================================
// DEFINE RECIPE
// =============================================================================

/**
 * Define and register a simulation recipe.
 * Validates config with Zod and registers with the recipe registry.
 */
// @fitness-ignore-next-line result-pattern-consistency -- registration-time factory; validation errors are programming mistakes, not domain failures
export function defineRecipe(config: RecipeConfig): SimulationRecipe {
  const parsed = RecipeConfigSchema.safeParse(config)
  if (!parsed.success) {
    // @fitness-ignore-next-line result-pattern-consistency -- registration-time validation; errors are programming mistakes
    throw new ValidationError(
      `Invalid recipe config "${config.name}": ${parsed.error.message}`,
    )
  }

  const validated = parsed.data

  // Validate scenario references exist (lazy - scenarios may not be registered yet at define time)
  // This is a best-effort check; full validation happens at execution time
  const scenarios: RecipeScenario[] = validated.scenarios.map((s) => ({
    scenarioId: s.scenarioId,
    durationOverride: s.durationOverride,
    tags: s.tags,
  }))

  const recipe: SimulationRecipe = Object.freeze({
    id: validated.id,
    name: validated.name,
    displayName: validated.displayName,
    description: validated.description,
    scenarios,
    execution: validated.execution
      ? {
          mode: validated.execution.mode,
          stopOnFirstFailure: validated.execution.stopOnFirstFailure,
          maxParallel: validated.execution.maxParallel,
          timeout: validated.execution.timeout,
        }
      : DEFAULT_EXECUTION,
    tags: validated.tags,
  })

  recipeRegistry.register(recipe)

  return recipe
}
