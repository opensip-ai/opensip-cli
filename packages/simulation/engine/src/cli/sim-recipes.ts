/**
 * sim-recipes command — list all available simulation recipes
 * (tool-command-surface-taxonomy Task 3.3).
 *
 * Sim already supports RUNNING a recipe (`sim --recipe <name>`) but had no
 * command to LIST recipes — a missing discoverability command, not an omission.
 * This adds the equivalent of fitness's `listRecipes` (`cli/fit-recipes.ts`) and
 * graph's `listGraphRecipes` (`cli/graph-recipes.ts`): it maps the scope-bound
 * simulation recipe registry to the shared `ListRecipesResult` contract so the
 * existing CLI renderer (`viewListRecipes`) handles the output with no contracts
 * change. `checkCount` is a free-form label; sim reuses it for tags / a built-in
 * marker.
 *
 * The command mounts in the canonical nested `<tool> <verb>` form under
 * `simulation`; the primary alias keeps `sim recipes` working. Sim never had a
 * legacy flat `sim-recipes`, so there is nothing to alias.
 */

import { defineNestedCommand } from '@opensip-cli/core';

import { currentSimulationRecipeRegistry } from '../recipes/registry.js';

import { ensureScenariosLoaded } from './sim.js';

import type { ListRecipesResult, ToolOptions } from '@opensip-cli/contracts';
import type { CommandSpec, ToolCliContext } from '@opensip-cli/core';

/**
 * Returns metadata for every registered simulation recipe (built-in plus
 * user-defined). Loads sim plugins first (via {@link ensureScenariosLoaded}) so
 * project-local + package recipes appear, mirroring how `fit-recipes` calls
 * `ensureChecksLoaded` before reading the registry. Reads
 * `currentSimulationRecipeRegistry()`, so it runs inside the entered RunScope.
 */
export async function listSimRecipes(projectDir?: string): Promise<ListRecipesResult> {
  // Load plugins so user-defined recipes (project-local + package scenarios with
  // co-located recipes) are registered before we read the registry.
  await ensureScenariosLoaded(projectDir);

  const recipes = currentSimulationRecipeRegistry()
    .listForDisplay()
    .map((recipe) => ({
      name: recipe.name,
      description: recipe.description,
      // `checkCount` is a free-form label the shared renderer prints in dim
      // parentheses; sim reuses it to surface the built-in/user-defined origin.
      checkCount: recipe.isBuiltIn ? 'built-in' : 'user-defined',
    }));

  return {
    type: 'list-recipes',
    recipes,
  };
}

/**
 * `simulation recipes` — list available simulation recipes. defineTool mounts
 * this draft as a subcommand of the canonical primary; `sim recipes` works via
 * the primary alias.
 * `command-result`: the host dispatches the returned result through the shared
 * seam (`--json` → JSON, else the shared `viewListRecipes` renderer) — the same
 * path `graph recipes` / `fit recipes` use.
 */
export const simRecipesCommandSpec: CommandSpec<unknown, ToolCliContext> = defineNestedCommand<
  unknown,
  ToolCliContext
>({
  name: 'recipes',
  description: 'List available simulation recipes',
  commonFlags: ['cwd', 'json'],
  scope: 'project',
  output: 'command-result',
  handler: async (rawOpts) => {
    const opts = rawOpts as ToolOptions;
    return listSimRecipes(opts.cwd);
  },
});
