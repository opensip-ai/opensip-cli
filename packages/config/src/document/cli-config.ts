/**
 * cli-config — the tool-agnostic `cli:` block of `opensip-cli.config.yml`.
 *
 * Owns three things, all relocated here under ADR-0023 §Amendment:
 *   - {@link CliDefaults} — the structural type the CLI pre-action hook reads.
 *   - {@link loadCliDefaults} — the permissive loader the hook calls to merge
 *     project-wide defaults (`--report-to`, `--exclude`, `--json`, `--api-key`,
 *     `verbose`, `debug`, the `cli.cloud` sync block) into Commander opts.
 *   - {@link cliConfigSchema} — the Zod schema the host registers as the `cli`
 *     document-level declaration so the composed whole-document validation
 *     STRICT-rejects a typo in `cli:` before dispatch.
 *
 * Previously this lived in `@opensip-cli/contracts` (`cli-config.ts`) — a
 * runtime YAML projection in a types-only package (the standing charter
 * violation ADR-0023 names). It now lives in the config layer, beside the rest
 * of the document blocks. The generic `readYamlFile` / `resolveProjectConfigPath`
 * primitives stay in `core` (path/read primitives — the config-resolution
 * decision in the ADR amendment); this module imports them from core.
 *
 * The loader is deliberately permissive — missing config, malformed YAML, or an
 * absent `cli:` key all return `{}`. Strict validation is the composed
 * document's job (the `cli` host declaration), not this reader's.
 */

import { readYamlFile, resolveProjectConfigPath } from '@opensip-cli/core';
import { z } from 'zod';

/** Config URLs that may carry credentials must use https. */
const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), {
    message: 'URL must use https://',
  });

/**
 * Shape of the `cli:` block in `opensip-cli.config.yml` as the CLI pre-action
 * hook reads it. The structural mirror of {@link cliConfigSchema}.
 */
export interface CliDefaults {
  readonly exclude?: readonly string[];
  readonly verbose?: boolean;
  readonly json?: boolean;
  readonly reportTo?: string;
  readonly apiKey?: string;
  readonly fileTypes?: readonly string[];
  readonly ignore?: readonly string[];
  readonly debug?: boolean;
  /**
   * Presentation settings (the `cli.ui:` sub-block). Currently just the
   * banner size shown above each command. Unlike the other defaults this
   * does NOT map onto a Commander flag — there is no `--banner`; it rides
   * on `RunScope.ui` and is read by the render paths directly.
   */
  readonly ui?: {
    /** Banner art: `mini` (default) | `lg` | `md` | `sm`. */
    readonly banner?: 'lg' | 'md' | 'sm' | 'mini';
  };
  /**
   * OpenSIP Cloud signal sync (ADR-0008). When the customer has an API key
   * and is entitled to the storage tier, each run additionally emits its
   * signals to OpenSIP Cloud (best-effort; local SQLite is unaffected).
   * `sync` defaults to `true` when entitled — set `false` to opt out.
   * `endpoint` overrides the built-in OpenSIP Cloud URL (must be https).
   */
  readonly cloud?: {
    readonly sync?: boolean;
    readonly endpoint?: string;
  };
}

/**
 * The Zod schema for the `cli:` document-level block. A superset of the legacy
 * fitness `CliDefaultsSchema` (it additionally claims `debug` and the
 * `cli.cloud` sub-block the permissive loader always read) so the composed
 * STRICT validation never rejects a key the loader honours. Strictness is
 * applied at the document level by the composer (`.strict()` on the namespace),
 * so nested `ui`/`cloud` objects stay lenient — matching prior behaviour.
 */
export const cliConfigSchema = z.object({
  exclude: z.array(z.string()).optional(),
  verbose: z.boolean().optional(),
  json: z.boolean().optional(),
  reportTo: httpsUrlSchema.optional(),
  apiKey: z.string().min(1).optional(),
  fileTypes: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
  debug: z.boolean().optional(),
  ui: z
    .object({
      banner: z.enum(['lg', 'md', 'sm', 'mini']).optional(),
    })
    .optional(),
  cloud: z
    .object({
      sync: z.boolean().optional(),
      endpoint: httpsUrlSchema.optional(),
    })
    .optional(),
});

/** Valid `ui.banner` values; anything else is dropped (→ default applies). */
const BANNER_VALUES: ReadonlySet<string> = new Set(['lg', 'md', 'sm', 'mini']);

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
  const ui = projectUiDefaults(raw.ui);
  if (ui) out.ui = ui;
  const cloud = projectCloudDefaults(raw.cloud);
  if (cloud) out.cloud = cloud;
  return out;
}

/** Project the `cli.cloud:` sub-block (sync flag + endpoint override) into the typed shape. */
function projectCloudDefaults(raw: unknown): CliDefaults['cloud'] | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: {
    -readonly [K in keyof NonNullable<CliDefaults['cloud']>]: NonNullable<CliDefaults['cloud']>[K];
  } = {};
  if (typeof raw.sync === 'boolean') out.sync = raw.sync;
  if (typeof raw.endpoint === 'string') out.endpoint = raw.endpoint;
  return out.sync === undefined && out.endpoint === undefined ? undefined : out;
}

/** Project the `cli.ui:` sub-block into the typed shape; drop unknown banner values. */
function projectUiDefaults(raw: unknown): CliDefaults['ui'] | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.banner === 'string' && BANNER_VALUES.has(raw.banner)) {
    return { banner: raw.banner as NonNullable<CliDefaults['ui']>['banner'] };
  }
  return undefined;
}

/**
 * Best-effort load of the `cli:` block from `opensip-cli.config.yml`.
 * Resolves the file via the core `resolveProjectConfigPath` primitive.
 *
 * Returns `{}` when the config is missing, unreadable, malformed, or has no
 * `cli:` section — the merge step treats absence and "everything default" the
 * same.
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
