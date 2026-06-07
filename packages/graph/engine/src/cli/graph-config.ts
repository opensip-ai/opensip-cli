/**
 * graph-config — load the `graph:` block of `opensip-tools.config.yml`
 * into a {@link GraphConfig}.
 *
 * The graph rule knobs (`minDuplicateBodyLines`, `minDuplicateBodySize`,
 * `minCrossPackageDuplicatePackages`, `minCrossPackageDuplicateBodySize`,
 * `entryPointHashes`, `severityOverrides`) are owned by the graph tool, so the graph engine
 * reads its own config block — mirroring the way fitness owns its
 * sections and the CLI seam owns the `cli:` block
 * (`@opensip-tools/contracts` `loadCliDefaults`).
 *
 * Release 2.10.0 (ADR-0023, Phase 4): the block is now read through graph's
 * own Zod {@link GraphConfigSchema} (the same schema graph contributes to the
 * host's composed whole-document validation) instead of the old hand-rolled
 * `projectGraphConfig`. The composed dispatch-level validation is the STRICT
 * gate that rejects a typo inside `graph:` before any command runs; this
 * loader stays permissive at its own call sites — a missing config, malformed
 * YAML, an absent `graph:` key, or a block that fails the schema all collapse
 * to `{}` so a rule falls back to its in-rule default and a mid-run read never
 * throws.
 */

import { logger, readYamlFile, resolveProjectConfigPath } from '@opensip-tools/core';
import { loadCliDefaults, resolveToolRecipeName, type ResolvedRecipe } from '@opensip-tools/contracts';

import { GraphConfigSchema } from './graph-config-schema.js';

import type { GraphConfig } from '../types.js';

/** Accept anything that looks like a plain object; everything else → `{}`. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Best-effort load of the `graph:` block from `opensip-tools.config.yml`.
 *
 * Returns `{}` when the config is missing, unreadable, malformed, has no
 * `graph:` section, or the section fails the graph schema — every rule then
 * falls back to its in-rule default. The strict typo rejection happens at the
 * dispatch-level composed validation, not here.
 *
 * @param cwd Project root for config resolution.
 * @param explicitPath Optional `--config <path>` override.
 */
export function loadGraphConfig(cwd: string, explicitPath?: string): GraphConfig {
  let filePath: string;
  try {
    filePath = resolveProjectConfigPath(cwd, explicitPath);
  } catch (error) {
    // No config file found — expected; the graph rules use their in-rule
    // defaults. Debug-only so it never adds noise on config-less projects.
    logger.debug({
      evt: 'graph.config.not_found',
      module: 'graph:config',
      err: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
  const doc = readYamlFile(filePath);
  if (!isPlainObject(doc)) return {};
  const graphBlock = doc.graph;
  if (!isPlainObject(graphBlock)) return {};
  // Parse the block through graph's own Zod schema, made `.strict()` to match
  // the dispatch-level composed validation (an unknown key inside `graph:` is
  // rejected, ADR-0023). A schema failure here is NOT fatal at the loader (the
  // strict dispatch-level gate already surfaced it as a CONFIGURATION_ERROR
  // before the command ran); fall back to `{}` so the call site keeps its
  // historical "absent → in-rule default" semantics.
  const parsed = GraphConfigSchema.strict().safeParse(graphBlock);
  if (!parsed.success) {
    logger.debug({
      evt: 'graph.config.schema_rejected',
      module: 'graph:config',
      err: parsed.error.message,
    });
    return {};
  }
  return parsed.data;
}

/**
 * Resolve which recipe NAME a `graph` run should use (ADR-0022), applying the
 * tool-scoped precedence: explicit `--recipe` > `graph.recipe` > deprecated
 * `cli.recipe` > built-in `default`. Reads both the `graph:` block and the
 * `cli:` block and delegates the precedence/tolerance decision to the shared
 * `resolveToolRecipeName`. The caller turns the returned `name` into rules via
 * `resolveRecipeToRules(name, { tolerant })` and warns on a deprecated fallback.
 *
 * @param cwd Project root for config resolution.
 * @param explicit The `--recipe <name>` flag value (undefined when absent).
 * @param explicitPath Optional `--config <path>` override.
 */
export function resolveGraphRecipeSelection(
  cwd: string,
  explicit: string | undefined,
  explicitPath?: string,
): ResolvedRecipe {
  const graphConfig = loadGraphConfig(cwd, explicitPath);
  const cliDefaults = loadCliDefaults(cwd, explicitPath);
  const resolved = resolveToolRecipeName({
    explicit,
    toolRecipe: graphConfig.recipe,
    // eslint-disable-next-line sonarjs/deprecation -- ADR-0022: cli.recipe is deprecated but deliberately read here as the cross-tool FALLBACK; resolveToolRecipeName ranks it last and the fitness check drives migration.
    cliRecipe: cliDefaults.recipe,
  });
  if (resolved.usedDeprecatedCliRecipe) {
    logger.warn({
      evt: 'graph.recipe.cli_recipe_deprecated',
      module: 'graph:config',
      recipe: resolved.name,
      msg: `cli.recipe is deprecated (ADR-0022); set graph.recipe instead. Using '${resolved.name}' as a fallback for graph.`,
    });
  }
  return resolved;
}
