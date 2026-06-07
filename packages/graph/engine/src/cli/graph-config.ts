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
 * The loader is deliberately permissive: a missing config, malformed
 * YAML, or an absent `graph:` key all collapse to `{}` (every rule then
 * uses its in-rule default). Only the field types are projected — strict
 * validation is not this loader's job.
 */

import { loadCliDefaults, resolveToolRecipeName, type ResolvedRecipe } from '@opensip-tools/contracts';
import { logger, readYamlFile, resolveProjectConfigPath } from '@opensip-tools/core';

import type { GraphConfig } from '../types.js';

/** Accept anything that looks like a plain object; everything else → `{}`. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Coerce a YAML value into a non-negative number if it is one; else drop it. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Coerce a YAML value into a `string[]` if it is one; otherwise drop it. */
function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v) => typeof v === 'string')) return undefined;
  return value;
}

/**
 * Coerce a YAML value into the `cycleSize2Severity` posture if it is one of
 * the two allowed strings; otherwise drop it. Mirrors `asSeverityOverrides`'s
 * value-narrowing. (Plan A integration note: if a nested band-table override
 * shape later lands, add an `asThresholdTable` projector here and switch the
 * numeric projections to it — Open Question #3. Flat scalars for now.)
 */
function asThresholdSeverity(value: unknown): 'off' | 'low' | undefined {
  return value === 'off' || value === 'low' ? value : undefined;
}

/** Project the `graph.severityOverrides` sub-block into the typed shape. */
function asSeverityOverrides(
  value: unknown,
): Readonly<Record<string, 'error' | 'warning'>> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, 'error' | 'warning'> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === 'error' || v === 'warning') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Project an arbitrary YAML `graph:` object into the typed `GraphConfig` shape. */
function projectGraphConfig(raw: Record<string, unknown>): GraphConfig {
  const out: { -readonly [K in keyof GraphConfig]: GraphConfig[K] } = {};
  if (typeof raw.recipe === 'string') out.recipe = raw.recipe;
  const minLines = asNumber(raw.minDuplicateBodyLines);
  if (minLines !== undefined) out.minDuplicateBodyLines = minLines;
  const minSize = asNumber(raw.minDuplicateBodySize);
  if (minSize !== undefined) out.minDuplicateBodySize = minSize;
  const minPackages = asNumber(raw.minCrossPackageDuplicatePackages);
  if (minPackages !== undefined) out.minCrossPackageDuplicatePackages = minPackages;
  const minCrossPkgBodySize = asNumber(raw.minCrossPackageDuplicateBodySize);
  if (minCrossPkgBodySize !== undefined) out.minCrossPackageDuplicateBodySize = minCrossPkgBodySize;
  const entryPointHashes = asStringArray(raw.entryPointHashes);
  if (entryPointHashes) out.entryPointHashes = entryPointHashes;
  // Structural-rule thresholds (Plan D). Each is permissively projected via
  // asNumber — missing/malformed values are dropped so the rule falls back to
  // its in-rule default.
  const largeWarn = asNumber(raw.largeFunctionWarnLines);
  if (largeWarn !== undefined) out.largeFunctionWarnLines = largeWarn;
  const largeError = asNumber(raw.largeFunctionErrorLines);
  if (largeError !== undefined) out.largeFunctionErrorLines = largeError;
  const wideWarn = asNumber(raw.wideFunctionWarnParams);
  if (wideWarn !== undefined) out.wideFunctionWarnParams = wideWarn;
  const wideError = asNumber(raw.wideFunctionErrorParams);
  if (wideError !== undefined) out.wideFunctionErrorParams = wideError;
  const blastWarn = asNumber(raw.highBlastWarnThreshold);
  if (blastWarn !== undefined) out.highBlastWarnThreshold = blastWarn;
  const blastError = asNumber(raw.highBlastErrorThreshold);
  if (blastError !== undefined) out.highBlastErrorThreshold = blastError;
  const cycleMin = asNumber(raw.cycleMinSize);
  if (cycleMin !== undefined) out.cycleMinSize = cycleMin;
  const cycleSize2 = asThresholdSeverity(raw.cycleSize2Severity);
  if (cycleSize2) out.cycleSize2Severity = cycleSize2;
  const severityOverrides = asSeverityOverrides(raw.severityOverrides);
  if (severityOverrides) out.severityOverrides = severityOverrides;
  return out;
}

/**
 * Best-effort load of the `graph:` block from `opensip-tools.config.yml`.
 *
 * Returns `{}` when the config is missing, unreadable, malformed, or has
 * no `graph:` section — every rule then falls back to its in-rule
 * default.
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
  return projectGraphConfig(graphBlock);
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
