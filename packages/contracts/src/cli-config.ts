/**
 * cli-config — tool-agnostic loader for the `cli:` block of
 * `opensip-tools.config.yml`.
 *
 * The CLI's pre-action hook merges a small set of project-wide defaults
 * (`recipe`, `--report-to`, `--json`, `--exclude`, `--api-key`,
 * `verbose`, `debug`) into Commander-parsed opts on every invocation.
 * That merge is the composition root's concern: it gates logger
 * silence/debug for every tool, supplies the global `--report-to`
 * destination, and resolves the cloud API key. None of those settings
 * are owned by any single tool.
 *
 * Lives in contracts (not core, not fitness) because:
 *   - core is the kernel: no YAML, no project-level config schemas.
 *   - fitness owns the *fitness* sections of the same file (targets,
 *     check overrides, fail thresholds). Reaching back into fitness for
 *     the `cli:` block inverts the layering — a project shipping only
 *     `simulation` would still need fitness installed just to read its
 *     own CLI defaults.
 *   - contracts already owns the CLI↔tool seam (`CommandResult`,
 *     `EXIT_CODES`, `CliProgram`); the `cli:` config block is the same
 *     seam, one layer lower.
 *
 * The loader is deliberately permissive — missing config, malformed
 * YAML, or an absent `cli:` key all return `{}`. Strict validation
 * belongs to the section's owner (fitness's `loadSignalersConfig`
 * still validates the full document including `cli:`); this loader
 * only needs the field types right enough for the merge.
 */

import { readYamlFile, resolveProjectConfigPath } from '@opensip-tools/core';

/**
 * Shape of the `cli:` block in `opensip-tools.config.yml` as the CLI
 * pre-action hook reads it. A subset / mirror of the Zod schema that
 * fitness owns end-to-end — kept here as a structural type so the CLI
 * can read the block without dragging fitness into the bootstrap path.
 */
export interface CliDefaults {
  readonly recipe?: string;
  readonly exclude?: readonly string[];
  readonly verbose?: boolean;
  readonly json?: boolean;
  readonly reportTo?: string;
  readonly apiKey?: string;
  readonly fileTypes?: readonly string[];
  readonly ignore?: readonly string[];
  readonly debug?: boolean;
}

/**
 * Type guard for permissive YAML reading. We accept anything that
 * looks like a plain object; everything else collapses to `{}`.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Coerce a YAML value into a `string[]` if it is one; otherwise drop it. */
function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v) => typeof v === 'string')) return undefined;
  return value;
}

/** Project an arbitrary YAML object into the typed `CliDefaults` shape. */
function projectCliDefaults(raw: Record<string, unknown>): CliDefaults {
  const out: { -readonly [K in keyof CliDefaults]: CliDefaults[K] } = {};
  if (typeof raw.recipe === 'string') out.recipe = raw.recipe;
  const exclude = asStringArray(raw.exclude);
  if (exclude) out.exclude = exclude;
  if (typeof raw.verbose === 'boolean') out.verbose = raw.verbose;
  if (typeof raw.json === 'boolean') out.json = raw.json;
  if (typeof raw.reportTo === 'string') out.reportTo = raw.reportTo;
  if (typeof raw.apiKey === 'string') out.apiKey = raw.apiKey;
  const fileTypes = asStringArray(raw.fileTypes);
  if (fileTypes) out.fileTypes = fileTypes;
  const ignore = asStringArray(raw.ignore);
  if (ignore) out.ignore = ignore;
  if (typeof raw.debug === 'boolean') out.debug = raw.debug;
  return out;
}

/**
 * Best-effort load of the `cli:` block from
 * `opensip-tools.config.yml`. Resolves the file via the same
 * `resolveProjectConfigPath` helper the rest of the toolchain uses.
 *
 * Returns `{}` when the config is missing, unreadable, malformed, or
 * has no `cli:` section — the merge step treats absence and
 * "everything default" the same.
 *
 * @param cwd Project root for config resolution.
 * @param explicitPath Optional `--config <path>` override.
 */
export function loadCliDefaults(cwd: string, explicitPath?: string): CliDefaults {
  let filePath: string;
  try {
    filePath = resolveProjectConfigPath(cwd, explicitPath);
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- documented contract (see JSDoc above): failure to resolve the project config is equivalent to "no cli: section" and treated identically by the merge step.
    return {};
  }
  const doc = readYamlFile(filePath);
  if (!isPlainObject(doc)) return {};
  const cliBlock = doc.cli;
  if (!isPlainObject(cliBlock)) return {};
  return projectCliDefaults(cliBlock);
}
