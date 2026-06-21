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
const httpsUrlSchema = z.string().refine(
  (value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      // @fitness-ignore-next-line error-handling-quality -- URL-validation predicate: a malformed URL is a normal "not https" result (false), not an error to log; mirrors the existing error-handling-quality suppression elsewhere in this file.
      return false;
    }
  },
  { message: 'URL must use https://' },
);

/**
 * `--report-to` is dual-mode: a LOCAL FILE PATH (written to disk) or a URL (the
 * report is POSTed). A file path is accepted as-is; a URL target must be https
 * (the report can carry findings) — so a plaintext http URL is rejected, but a
 * bare path is not mistaken for an insecure URL.
 */
const reportToSchema = z.string().refine(
  (value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      // @fitness-ignore-next-line error-handling-quality -- not a URL ⇒ a local file path, which is a valid report target (no error to log).
      return true;
    }
    return url.protocol === 'https:';
  },
  { message: 'a URL report target must use https:// (a local file path is also accepted)' },
);

/**
 * The Zod schema for the `cli:` document-level block — the SINGLE SOURCE OF TRUTH
 * (M8) for both the {@link CliDefaults} TYPE (via `z.infer`) and validation. A
 * superset of the legacy fitness `CliDefaultsSchema` (it additionally claims
 * `debug` and the `cli.cloud` sub-block the permissive loader always read) so the
 * composed STRICT validation never rejects a key the loader honours. Strictness
 * is applied at the document level by the composer (`.strict()` on the
 * namespace), so nested `ui`/`cloud` objects stay lenient — matching prior
 * behaviour.
 */
export const cliConfigSchema = z.object({
  exclude: z.array(z.string()).optional(),
  verbose: z.boolean().optional(),
  json: z.boolean().optional(),
  // Dual-mode (file path | https URL) — see reportToSchema. The prior https-only
  // schema silently disagreed with the loader (which accepted any string) AND
  // rejected valid file paths: the M8 drift this single-sourcing exposed.
  reportTo: reportToSchema.optional(),
  apiKey: z.string().min(1).optional(),
  fileTypes: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
  debug: z.boolean().optional(),
  // Presentation (`cli.ui:`). `banner` is the only key, and unlike the other
  // defaults it does NOT map onto a Commander flag (there is no `--banner`) — it
  // rides on RunScope.ui and the render paths read it directly.
  ui: z
    .object({
      banner: z.enum(['lg', 'md', 'sm', 'mini']).optional(),
    })
    .optional(),
  // OpenSIP Cloud signal sync (ADR-0008): with an API key + entitlement, each run
  // also emits its signals to OpenSIP Cloud (best-effort; local SQLite unaffected).
  // `sync` defaults to true when entitled — set false to opt out. `endpoint`
  // overrides the built-in URL (must be https — enforced by httpsUrlSchema).
  cloud: z
    .object({
      sync: z.boolean().optional(),
      endpoint: httpsUrlSchema.optional(),
    })
    .optional(),
});

/**
 * Shape of the `cli:` block as the CLI pre-action hook reads it — INFERRED from
 * {@link cliConfigSchema} so the type and the validator can never drift (M8 — was
 * previously a hand-maintained interface mirroring the schema).
 */
export type CliDefaults = z.infer<typeof cliConfigSchema>;

/**
 * Type guard for permissive YAML reading. We accept anything that
 * looks like a plain object; everything else collapses to `{}`.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Project a raw `cli:` YAML object into {@link CliDefaults} by validating each key
 * against its OWN {@link cliConfigSchema} field (M8 — the projector is now DERIVED
 * from the schema, not a hand-maintained third representation alongside the type
 * and the schema).
 *
 * Per-field permissive, matching the long-standing loader contract + tests: a
 * field that fails its sub-schema is dropped while the rest are kept, so one bad
 * key never discards a whole valid block. A nested object (`ui`/`cloud`) that
 * validates to `{}` (only unrecognised keys, which Zod strips) collapses to
 * absent. Strict whole-document validation (typo rejection) stays the composer's
 * job, via this same schema.
 */
function projectCliDefaults(raw: Record<string, unknown>): CliDefaults {
  const out: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(cliConfigSchema.shape)) {
    if (!(key in raw)) continue;
    const result = fieldSchema.safeParse(raw[key]);
    if (!result.success) continue;
    const value: unknown = result.data;
    if (value === undefined) continue;
    // A nested object that validated to {} (e.g. `cloud: { bogus: 1 }`) reads as
    // absent, not an empty object — preserves the prior projector's behaviour.
    if (isPlainObject(value) && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out;
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
