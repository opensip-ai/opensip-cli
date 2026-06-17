// @fitness-ignore-file null-safety -- Zod schema builder chains (.strict()/.safeParse()) always return valid objects; `.safeParse` is called on a freshly-built strict schema, never a nullable reference.
/**
 * graph-config — load the `graph:` block of `opensip-cli.config.yml`
 * into a {@link GraphConfig}.
 *
 * The graph rule knobs (`minDuplicateBodyLines`, `minDuplicateBodySize`,
 * `minCrossPackageDuplicatePackages`, `minCrossPackageDuplicateBodySize`,
 * `entryPointHashes`, `severityOverrides`) are owned by the graph tool, so the graph engine
 * reads its own config block — mirroring the way fitness owns its
 * sections and the CLI seam owns the `cli:` block
 * (`@opensip-cli/contracts` `loadCliDefaults`).
 *
 * Launch (ADR-0023, Phase 4): the block is now read through graph's
 * own Zod {@link GraphConfigSchema} (the same schema graph contributes to the
 * host's composed whole-document validation) instead of the old hand-rolled
 * `projectGraphConfig`. The composed dispatch-level validation is the STRICT
 * gate that rejects a typo inside `graph:` before any command runs; this
 * loader stays permissive at its own call sites — a missing config, malformed
 * YAML, an absent `graph:` key, or a block that fails the schema all collapse
 * to `{}` so a rule falls back to its in-rule default and a mid-run read never
 * throws.
 */

import { resolveToolRecipeName, type ResolvedRecipe } from '@opensip-cli/contracts';
import { currentScope, logger, readYamlFile, resolveProjectConfigPath } from '@opensip-cli/core';

import { GraphConfigSchema } from './graph-config-schema.js';

import type { GraphConfig } from '../types.js';

/** Accept anything that looks like a plain object; everything else → `{}`. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Best-effort load of the `graph:` block of `opensip-cli.config.yml`.
 *
 * ADR-0023, Phase 4: the resolved `graph:` block rides on the per-run scope
 * (`scope.toolConfig.graph`) — the host already strict-validated + precedence-
 * resolved (flag > env > file > defaults) the whole document before dispatch. So
 * when a scope is present (every in-process AND forked-worker run goes through
 * the pre-action hook) this returns the SCOPE value and does NOT re-read YAML.
 * The YAML read below is the fallback for a caller with no scope (a unit test
 * driving `loadGraphConfig` directly) — there it stays best-effort: a missing
 * config, malformed YAML, an absent `graph:` key, or a block that fails the
 * schema all collapse to `{}` so a rule falls back to its in-rule default.
 *
 * @param cwd Project root for config resolution.
 * @param explicitPath Optional `--config <path>` override.
 */
export function loadGraphConfig(cwd: string, explicitPath?: string): GraphConfig {
  // Scope-first: the resolved, strict-validated `graph:` block (with env/flag
  // precedence already folded in). Present on every CLI dispatch path; absent
  // only off-CLI (direct unit-test calls), where we fall back to the YAML read.
  const scope = currentScope();
  const scoped = scope?.toolConfig?.graph;
  if (isPlainObject(scoped)) {
    // Already validated by the composer (graph's namespaced ToolConfigDeclaration
    // is the same GraphConfigSchema), so this is a pure narrowing read.
    return scoped;
  }
  const documentGraph = scope?.configDocument?.graph;
  if (isPlainObject(documentGraph)) {
    const parsed = GraphConfigSchema.strict().safeParse(documentGraph);
    if (parsed.success) return parsed.data;
    logger.debug({
      evt: 'graph.config.scope_document_schema_rejected',
      module: 'graph:config',
      err: parsed.error.message,
    });
    return {};
  }
  if (scope !== undefined) {
    // A scope-bound dispatch has already had its config composed. If there is no
    // resolved graph block, do not perform a second YAML read; use graph's
    // in-rule defaults instead.
    return {};
  }

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
 * tool-scoped precedence: explicit `--recipe` > `graph.recipe` > built-in
 * `default`. Delegates the precedence/tolerance decision to the shared
 * `resolveToolRecipeName`. The caller turns the returned `name` into rules via
 * `resolveRecipeToRules(name, { tolerant })`.
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
  return resolveToolRecipeName({
    explicit,
    toolRecipe: graphConfig.recipe,
  });
}
