/**
 * sim-config — resolve the `sim` recipe default (ADR-0022).
 *
 * Recipes are tool-scoped: `sim` reads its own `simulation.recipe` block from
 * `opensip-tools.config.yml`, with the deprecated `cli.recipe` as a cross-tool
 * fallback. The `simulation:` block is read permissively here (mirroring graph's
 * `graph-config.ts`) — simulation must not depend on fitness, which owns the
 * strict Zod config schema, so it parses its own slice of the document.
 */

import { loadCliDefaults, resolveToolRecipeName, type ResolvedRecipe } from '@opensip-tools/contracts';
import { logger, readYamlFile, resolveProjectConfigPath } from '@opensip-tools/core';

/** Accept anything that looks like a plain object; everything else → undefined. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Best-effort read of `simulation.recipe` from the project config. Returns
 * `undefined` when the config is missing, unreadable, malformed, or has no
 * `simulation.recipe` string.
 */
function readSimulationRecipe(cwd: string, explicitPath?: string): string | undefined {
  let filePath: string;
  try {
    filePath = resolveProjectConfigPath(cwd, explicitPath);
  } catch {
    return undefined;
  }
  const doc = readYamlFile(filePath);
  if (!isPlainObject(doc)) return undefined;
  const block = doc.simulation;
  if (!isPlainObject(block)) return undefined;
  return typeof block.recipe === 'string' ? block.recipe : undefined;
}

/**
 * Resolve which recipe NAME a `sim` run should use, applying tool-scoped
 * precedence (ADR-0022): explicit `--recipe` > `simulation.recipe` > deprecated
 * `cli.recipe` > built-in `default`. The caller looks up the returned `name` in
 * the recipe registry and, when `tolerant`, falls back to `default` on a miss.
 *
 * @param cwd Project root for config resolution.
 * @param explicit The `--recipe <name>` flag value (undefined when absent).
 * @param explicitPath Optional `--config <path>` override.
 */
export function resolveSimRecipeSelection(
  cwd: string,
  explicit: string | undefined,
  explicitPath?: string,
): ResolvedRecipe {
  const toolRecipe = readSimulationRecipe(cwd, explicitPath);
  const cliDefaults = loadCliDefaults(cwd, explicitPath);
  const resolved = resolveToolRecipeName({
    explicit,
    toolRecipe,
    // eslint-disable-next-line sonarjs/deprecation -- ADR-0022: cli.recipe is deprecated but deliberately read here as the cross-tool FALLBACK; resolveToolRecipeName ranks it last and the fitness check drives migration.
    cliRecipe: cliDefaults.recipe,
  });
  if (resolved.usedDeprecatedCliRecipe) {
    logger.warn({
      evt: 'sim.recipe.cli_recipe_deprecated',
      module: 'cli:sim',
      recipe: resolved.name,
      msg: `cli.recipe is deprecated (ADR-0022); set simulation.recipe instead. Using '${resolved.name}' as a fallback for sim.`,
    });
  }
  return resolved;
}
