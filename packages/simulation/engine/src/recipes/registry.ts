/**
 * @fileoverview Sim recipe registry — thin wrapper around the kernel's
 * `RecipeRegistry<T>` (Layer 1 / core) that adds simulation-specific
 * concerns: built-in recipe pre-registration with throw-on-duplicate
 * semantics, and display info with `isBuiltIn` / `isUserDefined` flags.
 */

import { RecipeRegistry } from '@opensip-tools/core';

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

export class SimulationRecipeRegistry extends RecipeRegistry<SimulationRecipe> {
  constructor() {
    super({ module: 'simulation:recipes', validationCode: 'VALIDATION.SIMULATION.DUPLICATE_RECIPE' });
    this.registerBuiltInRecipes();
  }

  private registerBuiltInRecipes(): void {
    // Built-in recipes ship valid; bypass the duplicate guard via direct
    // map writes to preserve registration order semantics.
    for (const recipe of builtInSimulationRecipes) {
      this.byId.set(recipe.id, recipe);
      this.byName.set(recipe.name, recipe);
    }
  }

  /**
   * Register a simulation recipe. Throws on duplicate id/name unless
   * `allowOverwrite: true` is passed — historical contract preserved
   * by routing through the kernel registry's `throwOnDuplicate` flag.
   */
  override register(
    recipe: SimulationRecipe,
    options?: { allowOverwrite?: boolean },
  ): void {
    super.register(recipe, {
      allowOverwrite: options?.allowOverwrite ?? false,
      throwOnDuplicate: !(options?.allowOverwrite ?? false),
    });
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
