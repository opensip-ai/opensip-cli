/**
 * graph-config — load the `graph:` block of `opensip-tools.config.yml`
 * into a {@link GraphConfig}.
 *
 * The graph rule knobs (`minDuplicateBodyLines`, `minDuplicateBodySize`,
 * `minCrossPackageDuplicatePackages`, `entryPointHashes`,
 * `severityOverrides`) are owned by the graph tool, so the graph engine
 * reads its own config block — mirroring the way fitness owns its
 * sections and the CLI seam owns the `cli:` block
 * (`@opensip-tools/contracts` `loadCliDefaults`).
 *
 * The loader is deliberately permissive: a missing config, malformed
 * YAML, or an absent `graph:` key all collapse to `{}` (every rule then
 * uses its in-rule default). Only the field types are projected — strict
 * validation is not this loader's job.
 */

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
  const minLines = asNumber(raw.minDuplicateBodyLines);
  if (minLines !== undefined) out.minDuplicateBodyLines = minLines;
  const minSize = asNumber(raw.minDuplicateBodySize);
  if (minSize !== undefined) out.minDuplicateBodySize = minSize;
  const minPackages = asNumber(raw.minCrossPackageDuplicatePackages);
  if (minPackages !== undefined) out.minCrossPackageDuplicatePackages = minPackages;
  const entryPointHashes = asStringArray(raw.entryPointHashes);
  if (entryPointHashes) out.entryPointHashes = entryPointHashes;
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
