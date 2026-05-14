// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
// @fitness-ignore-file no-console-log -- User recipe warnings/summary output before CLI framework is initialized
// @fitness-ignore-file logging-standards -- User recipe warnings/summary output before structured logger is available
/**
 * @fileoverview Fitness recipe registry
 *
 * Manages registration and lookup of fitness recipes (built-in and user-defined).
 */

import { ValidationError } from '@opensip-tools/core'

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
export class FitnessRecipeRegistry {
  private readonly byId = new Map<string, FitnessRecipe>()
  private readonly byName = new Map<string, FitnessRecipe>()
  private _userRecipesLoadResult: UserFitnessRecipesResult | undefined
  private readonly _overriddenBuiltIns = new Set<string>()

  constructor(options: FitnessRecipeRegistryOptions = {}) {
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
    for (const recipe of builtInRecipes) {
      this.byId.set(recipe.id, recipe)
      this.byName.set(recipe.name, recipe)
    }
  }

  private loadAndRegisterUserRecipes(
    _basePath: string | undefined,
    _logWarnings: boolean,
    _logSummary: boolean,
  ): void {
    // User recipe loading not ported to opensip-tools — stub
    this._userRecipesLoadResult = { recipes: [], warnings: [] }
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
    return Array.from(this._overriddenBuiltIns)
  }

  /** Look up a recipe by name or ID */
  loadRecipe(nameOrId: string): FitnessRecipe | undefined {
    return this.byName.get(nameOrId) ?? this.byId.get(nameOrId)
  }

  /** Retrieve a recipe by its name */
  getByName(name: string): FitnessRecipe | undefined {
    return this.byName.get(name)
  }

  /** Retrieve a recipe by its ID */
  getById(id: string): FitnessRecipe | undefined {
    return this.byId.get(id)
  }

  /** Check whether a recipe exists by name or ID */
  has(nameOrId: string): boolean {
    return this.byName.has(nameOrId) || this.byId.has(nameOrId)
  }

  /** Return all registered recipes */
  getAllRecipes(): readonly FitnessRecipe[] {
    return [...this.byId.values()]
  }

  /** Return all registered recipe names */
  getNames(): readonly string[] {
    return [...this.byName.keys()]
  }

  /** Return all recipes matching a given tag */
  getByTag(tag: string): readonly FitnessRecipe[] {
    return [...this.byId.values()].filter((r) => r.tags?.includes(tag))
  }

  /** Number of registered recipes */
  get size(): number {
    return this.byId.size
  }

  /** Register a recipe. Throws if already registered unless allowOverwrite is true. */
  register(recipe: FitnessRecipe, options?: { allowOverwrite?: boolean }): void {
    const allowOverwrite = options?.allowOverwrite ?? false
    if (!allowOverwrite && (this.byId.has(recipe.id) || this.byName.has(recipe.name))) {
      // @fitness-ignore-next-line result-pattern-consistency -- internal registration guard, throw is appropriate
      throw new ValidationError(`Recipe '${recipe.name}' (${recipe.id}) already registered`, { code: 'VALIDATION.FITNESS.DUPLICATE_RECIPE' })
    }
    this.byId.set(recipe.id, recipe)
    this.byName.set(recipe.name, recipe)
  }

  /** Register multiple recipes at once */
  registerAll(recipes: readonly FitnessRecipe[], options?: { allowOverwrite?: boolean }): void {
    if (!Array.isArray(recipes)) return
    for (const recipe of recipes) {
      this.register(recipe, options)
    }
  }

  /** Remove a recipe by ID. Returns true if the recipe was found and removed. */
  remove(id: string): boolean {
    const recipe = this.byId.get(id)
    if (!recipe) return false
    this.byId.delete(id)
    this.byName.delete(recipe.name)
    return true
  }

  /** Remove all registered recipes */
  clear(): void {
    this.byId.clear()
    this.byName.clear()
  }

  /** Clear all recipes and re-register built-in recipes */
  reset(): void {
    this.clear()
    this.registerBuiltInRecipes()
  }

  /** Return display-friendly info for all registered recipes */
  listForDisplay(): readonly RecipeDisplayInfo[] {
    return [...this.byId.values()].map((recipe) => {
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
