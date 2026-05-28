/**
 * @fileoverview Sim recipe registry — thin wrapper around the kernel's
 * `RecipeRegistry<T>` (Layer 1 / core) that adds simulation-specific
 * concerns: built-in recipe pre-registration with throw-on-duplicate
 * semantics, and display info with `isBuiltIn` / `isUserDefined` flags.
 *
 * Per-RunScope: the simulation tool's `extendScope` hook constructs a
 * fresh `SimulationRecipeRegistry` per CLI invocation and attaches it
 * to `scope.simulation.recipes` (Item 1 / D7). The module-level
 * singleton is gone — consumers read via `currentSimulationRecipeRegistry()`
 * which routes through the scope-bound instance.
 *
 * Built-in seeding goes through `registerAll(builtIns, { internal: true })`
 * — the LSP-clean replacement for the prior direct-map-write pattern
 * (the canonical T2 violation the runscope+registry plan resolves).
 */

import { RecipeRegistry, currentScope } from '@opensip-tools/core';

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
    // Built-ins bypass the duplicate guard via { internal: true } —
    // replaces the prior direct map writes (the LSP violation).
    this.registerAll(builtInSimulationRecipes, { internal: true });
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
    this.registerAll(builtInSimulationRecipes, { internal: true });
  }

  listForDisplay(): readonly SimulationRecipeDisplayInfo[] {
    return this.getAllRecipes().map((recipe) => {
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

/** Factory used by the simulation tool's `extendScope` hook. */
export function createSimulationRecipeRegistry(): SimulationRecipeRegistry {
  return new SimulationRecipeRegistry();
}

/**
 * Read the current scope's simulation recipe registry. Throws when no
 * scope is active or when the simulation subscope is missing — both
 * indicate the caller is running outside the CLI's pre-action-hook (or
 * the test fixture forgot to construct + enter a scope).
 *
 * @throws {Error} When called outside `runWithScope(...)`, or when the
 *   active scope has no simulation subscope.
 */
export function currentSimulationRecipeRegistry(): SimulationRecipeRegistry {
  const scope = currentScope();
  if (!scope) {
    throw new Error(
      'simulation: currentSimulationRecipeRegistry() called outside a RunScope. ' +
        'Wrap the call site in runWithScope (production: pre-action-hook handles ' +
        'this; tests: use makeTestScope + simulationTool.extendScope or construct ' +
        'a registry directly).',
    );
  }
  if (!scope.simulation) {
    throw new Error(
      'simulation: scope.simulation is missing. The simulation tool must be ' +
        'registered and its extendScope hook must run before recipe reads. ' +
        '(production: bootstrap registers simulationTool; tests: call ' +
        'simulationTool.extendScope(scope) after makeTestScope.)',
    );
  }
  return scope.simulation.recipes;
}
