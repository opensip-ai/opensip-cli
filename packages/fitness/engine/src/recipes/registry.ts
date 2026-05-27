// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
// @fitness-ignore-file no-console-log -- User recipe warnings/summary output before CLI framework is initialized
// @fitness-ignore-file logging-standards -- User recipe warnings/summary output before structured logger is available
/**
 * @fileoverview Fitness recipe registry
 *
 * Thin wrapper around the kernel's `RecipeRegistry<T>` (Layer 1 / core)
 * that adds fitness-specific concerns: built-in recipe pre-registration
 * with throw-on-duplicate semantics, override tracking, and display
 * info enriched with `isBuiltIn` / `overridesBuiltIn` flags.
 *
 * Built-in seeding goes through `registerAll(builtIns, { internal: true })`
 * — the LSP-clean replacement for the prior direct-map-write pattern
 * (the canonical T2 violation the runscope+registry plan resolves).
 */

import { RecipeRegistry } from '@opensip-tools/core'

import { builtInRecipes, isBuiltInRecipe } from './built-in-recipes.js'

import type { FitnessRecipe } from './types.js'

/** Stub for user recipe loading (not ported to opensip-tools) */
interface UserFitnessRecipesResult {
  recipes: FitnessRecipe[]
  warnings: string[]
  loadedFrom?: string
}

/** Options for constructing a FitnessRecipeRegistry */
export interface FitnessRecipeRegistryOptions {
  readonly basePath?: string
  readonly loadUserRecipes?: boolean
  readonly logWarnings?: boolean
  readonly logSummary?: boolean
}

/** Display-friendly info about a registered recipe */
export interface RecipeDisplayInfo {
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly tags: readonly string[]
  readonly isBuiltIn: boolean
  readonly isUserDefined: boolean
  readonly overridesBuiltIn: boolean
}

/** Registry for fitness recipes, loading built-in and user-defined recipes */
export class FitnessRecipeRegistry extends RecipeRegistry<FitnessRecipe> {
  private _userRecipesLoadResult: UserFitnessRecipesResult | undefined
  private readonly _overriddenBuiltIns = new Set<string>()

  constructor(options: FitnessRecipeRegistryOptions = {}) {
    super({ module: 'fitness:recipes', validationCode: 'VALIDATION.FITNESS.DUPLICATE_RECIPE' })

    const {
      basePath,
      loadUserRecipes: shouldLoadUserRecipes = true,
      logWarnings = true,
      logSummary = false,
    } = options

    this.registerBuiltInRecipes()

    if (shouldLoadUserRecipes) {
      this.loadAndRegisterUserRecipes(basePath, logWarnings, logSummary)
    }
  }

  private registerBuiltInRecipes(): void {
    // Built-in recipes ship valid; `{ internal: true }` bypasses the
    // duplicate guard at the seed site so successive registrations
    // (or a reset()/re-seed) don't trip the warn-first-wins policy.
    // Replaces the prior direct-map-write LSP violation.
    this.registerAll(builtInRecipes, { internal: true })
  }

  private loadAndRegisterUserRecipes(
    _basePath: string | undefined,
    _logWarnings: boolean,
    _logSummary: boolean,
  ): void {
    // User recipe loading not ported to opensip-tools — stub
    this._userRecipesLoadResult = { recipes: [], warnings: [] }
  }

  /**
   * Register a fitness recipe. Throws on duplicate id/name unless
   * `allowOverwrite: true` is passed — historical contract preserved
   * by routing through the kernel registry's `throwOnDuplicate` flag.
   */
  override register(
    recipe: FitnessRecipe,
    options?: { allowOverwrite?: boolean },
  ): void {
    super.register(recipe, {
      allowOverwrite: options?.allowOverwrite ?? false,
      throwOnDuplicate: !(options?.allowOverwrite ?? false),
    })
  }

  /** Return the result of loading user-defined recipes, if attempted */
  getUserRecipesLoadResult(): UserFitnessRecipesResult | undefined {
    return this._userRecipesLoadResult
  }

  /** Check whether a built-in recipe has been overridden by a user recipe */
  isOverridden(name: string): boolean {
    return this._overriddenBuiltIns.has(name)
  }

  /** Return the names of all built-in recipes overridden by user recipes */
  getOverriddenBuiltIns(): readonly string[] {
    return [...this._overriddenBuiltIns]
  }

  /** Clear all recipes and re-register built-in recipes */
  reset(): void {
    this.clear()
    this.registerBuiltInRecipes()
  }

  /** Return display-friendly info for all registered recipes */
  listForDisplay(): readonly RecipeDisplayInfo[] {
    return this.getAllRecipes().map((recipe) => {
      const isUserRecipe = recipe.id.startsWith('URCP_')
      return {
        name: recipe.name,
        displayName: recipe.displayName,
        description: recipe.description,
        tags: recipe.tags ?? [],
        isBuiltIn: !isUserRecipe && isBuiltInRecipe(recipe.name),
        isUserDefined: isUserRecipe,
        overridesBuiltIn: this._overriddenBuiltIns.has(recipe.name),
      }
    })
  }
}

/** Shared singleton recipe registry with built-in recipes pre-loaded */
export const defaultRecipeRegistry = new FitnessRecipeRegistry({ logWarnings: false })
