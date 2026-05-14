/**
 * @fileoverview Sim recipe registry — mirrors FitnessRecipeRegistry's
 * shape so user-facing concepts stay parallel.
 */

import { ValidationError } from '@opensip-tools/core';

import { builtInSimulationRecipes } from './built-in-recipes.js';

import type { SimulationRecipe } from './types.js';

/** Display-friendly summary of a registered recipe. */
export interface SimulationRecipeDisplayInfo {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly isBuiltIn: boolean;
  readonly isUserDefined: boolean;
}

const BUILT_IN_NAMES = new Set(builtInSimulationRecipes.map((r) => r.name));

export class SimulationRecipeRegistry {
  private readonly byId = new Map<string, SimulationRecipe>();
  private readonly byName = new Map<string, SimulationRecipe>();

  constructor() {
    this.registerBuiltInRecipes();
  }

  private registerBuiltInRecipes(): void {
    for (const recipe of builtInSimulationRecipes) {
      this.byId.set(recipe.id, recipe);
      this.byName.set(recipe.name, recipe);
    }
  }

  loadRecipe(nameOrId: string): SimulationRecipe | undefined {
    return this.byName.get(nameOrId) ?? this.byId.get(nameOrId);
  }

  getByName(name: string): SimulationRecipe | undefined {
    return this.byName.get(name);
  }

  getById(id: string): SimulationRecipe | undefined {
    return this.byId.get(id);
  }

  has(nameOrId: string): boolean {
    return this.byName.has(nameOrId) || this.byId.has(nameOrId);
  }

  getAllRecipes(): readonly SimulationRecipe[] {
    return [...this.byId.values()];
  }

  getNames(): readonly string[] {
    return [...this.byName.keys()];
  }

  get size(): number {
    return this.byId.size;
  }

  /**
   * Register a recipe. By default refuses to overwrite an existing
   * entry — callers that legitimately want to swap (e.g. user recipe
   * overrides built-in `default`) pass `{ allowOverwrite: true }`.
   */
  register(recipe: SimulationRecipe, options?: { allowOverwrite?: boolean }): void {
    const allowOverwrite = options?.allowOverwrite ?? false;
    if (!allowOverwrite && (this.byId.has(recipe.id) || this.byName.has(recipe.name))) {
      throw new ValidationError(
        `SimulationRecipe '${recipe.name}' (${recipe.id}) already registered`,
        { code: 'VALIDATION.SIMULATION.DUPLICATE_RECIPE' },
      );
    }
    this.byId.set(recipe.id, recipe);
    this.byName.set(recipe.name, recipe);
  }

  registerAll(
    recipes: readonly SimulationRecipe[],
    options?: { allowOverwrite?: boolean },
  ): void {
    for (const recipe of recipes) {
      this.register(recipe, options);
    }
  }

  remove(id: string): boolean {
    const recipe = this.byId.get(id);
    if (!recipe) return false;
    this.byId.delete(id);
    this.byName.delete(recipe.name);
    return true;
  }

  clear(): void {
    this.byId.clear();
    this.byName.clear();
  }

  reset(): void {
    this.clear();
    this.registerBuiltInRecipes();
  }

  listForDisplay(): readonly SimulationRecipeDisplayInfo[] {
    return [...this.byId.values()].map((recipe) => {
      const isUser = recipe.id.startsWith('URCP_');
      return {
        name: recipe.name,
        displayName: recipe.displayName,
        description: recipe.description,
        tags: recipe.tags ?? [],
        isBuiltIn: !isUser && BUILT_IN_NAMES.has(recipe.name),
        isUserDefined: isUser,
      };
    });
  }
}

/** Shared singleton with the built-in `default` recipe pre-loaded. */
export const defaultSimulationRecipeRegistry = new SimulationRecipeRegistry();
