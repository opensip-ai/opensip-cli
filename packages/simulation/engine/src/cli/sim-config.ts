/**
 * sim-config — resolve the `sim` recipe default (ADR-0022).
 *
 * Recipes are tool-scoped: `sim` reads its own `simulation.recipe` block. When
 * a run scope exists, the host-resolved `simulation:` block is authoritative:
 * sim never re-reads YAML behind the composition root. Scope-less direct callers
 * keep the permissive best-effort file fallback.
 */

import { resolveToolRecipeName, type ResolvedRecipe } from '@opensip-cli/contracts';
import {
  createToolLogger,
  currentScope,
  isPlainRecord,
  readYamlFile,
  resolveProjectConfigPath,
} from '@opensip-cli/core';

const log = createToolLogger('simulation:cli');

/**
 * Best-effort read of `simulation.recipe` from the project config.
 *
 * ADR-0023, Phase 4: the resolved `simulation:` block rides on the per-run scope
 * (`scope.toolConfig.simulation`) — the host already strict-validated +
 * precedence-resolved the whole document before dispatch. When a scope is
 * present (every CLI dispatch path) this reads the SCOPE value and does NOT
 * re-read YAML. The YAML read below is the fallback for a caller with no scope
 * (a direct unit-test call); there it stays best-effort: a missing config,
 * malformed YAML, or no `simulation.recipe` string yields `undefined`.
 */
function readSimulationRecipe(cwd: string, explicitPath?: string): string | undefined {
  // Scope-first: the resolved, strict-validated `simulation:` block.
  const scope = currentScope();
  const scoped = scope?.toolConfig?.simulation;
  if (isPlainRecord(scoped)) {
    return typeof scoped.recipe === 'string' ? scoped.recipe : undefined;
  }
  if (scope !== undefined) {
    return undefined;
  }

  let filePath: string;
  try {
    filePath = resolveProjectConfigPath(cwd, explicitPath);
  } catch (error) {
    // No config file found — expected on a config-less project; sim then uses
    // the built-in default. Debug-only so it never adds noise. Mirrors
    // loadGraphConfig's not-found path.
    log.debug({
      evt: 'sim.config.not_found',
      module: 'cli:sim',
      err: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  const doc = readYamlFile(filePath);
  if (!isPlainRecord(doc)) return undefined;
  const block = doc.simulation;
  if (!isPlainRecord(block)) return undefined;
  return typeof block.recipe === 'string' ? block.recipe : undefined;
}

/**
 * Resolve which recipe NAME a `sim` run should use, applying tool-scoped
 * precedence (ADR-0022): explicit `--recipe` > `simulation.recipe` > built-in
 * `default`. The caller looks up the returned `name` in the recipe registry and,
 * when `tolerant`, falls back to `default` on a miss.
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
  return resolveToolRecipeName({
    explicit,
    toolRecipe,
  });
}
