/**
 * targeting — the shared two-layer scope model: the `targets:`,
 * `globalExcludes:`, and `checkOverrides:` document-level blocks of
 * `opensip-cli.config.yml`.
 *
 * This is cross-tool config, not a fitness concern — a project shipping only
 * `graph` resolves its scope through the same model. Relocated here from
 * `@opensip-cli/fitness` under ADR-0023. The data/runtime boundary:
 *
 *   - config owns the **document shape** — the types below and the Zod field
 *     schemas — so the composed whole-document validation can strict-check the
 *     three top-level blocks (the host declarations in {@link ./host-declarations}).
 *   - fitness keeps the **runtime** — its `TargetRegistry`, the registry build +
 *     the cross-validation that `checkOverrides` references known targets, and
 *     `resolveTargetFiles` (glob expansion). It builds those from the schemas
 *     here. Moving the registry down would invert the layer (config must not
 *     import a fitness runtime type).
 *
 * The `plugins:` block type lives here too (it rides on the loaded
 * `TargetsConfig`). Config owns the document shape + Zod validation; the
 * plugin-discovery runtime still lives with the generic capability loader and
 * each owning tool.
 */

import { z } from 'zod';

// =============================================================================
// Types (the document shape)
// =============================================================================

/** One convention-declared export that framework/runtime code reads dynamically. */
export interface TargetConventionUsedExportConfig {
  /** Project-relative file glob containing framework-used exports. */
  readonly file: string;
  /** Export names considered used even if static analysis cannot see the read. */
  readonly names: readonly string[];
}

/** Optional framework/runtime conventions attached to a named target. */
export interface TargetConventionsConfig {
  /** Project-relative file globs that are graph roots by convention. */
  readonly entrypoints?: readonly string[];
  /** Project-relative file globs that should not be reported as dead files. */
  readonly alwaysUsed?: readonly string[];
  /** File/export-name declarations that suppress unused-export findings. */
  readonly usedExports?: readonly TargetConventionUsedExportConfig[];
}

/** Convention path field names used in validation diagnostics. */
export type TargetConventionPathField = 'entrypoints' | 'alwaysUsed' | 'usedExports.file';

/** One unsafe target convention path discovered in a config block. */
export interface TargetConventionPathIssue {
  /** Convention field containing the unsafe path. */
  readonly field: TargetConventionPathField;
  /** Raw user-authored convention glob or file pattern. */
  readonly pattern: string;
}

/** Configuration for a named target (file set with include/exclude globs). */
export interface TargetConfig {
  /** Kebab-case identifier, e.g. 'backend', 'module-foundation' */
  readonly name: string;
  /** Human-readable description */
  readonly description: string;
  /** Glob patterns to include */
  readonly include: readonly string[];
  /** Glob patterns to exclude */
  readonly exclude: readonly string[];
  /** Tags for filtering/grouping */
  readonly tags?: readonly string[];
  /** Languages this target contains (e.g. 'typescript', 'tsx', 'json') */
  readonly languages?: readonly string[];
  /** Semantic concerns this target represents (e.g. 'backend', 'server', 'api') */
  readonly concerns?: readonly string[];
  /** Framework/runtime conventions that static analysis cannot infer reliably. */
  readonly conventions?: TargetConventionsConfig;
}

/** A resolved target wrapping its configuration. */
export interface Target {
  readonly config: TargetConfig;
}

/**
 * Per-check target overrides.
 * Maps check slug → target name(s) to restrict which files a check runs against.
 */
export type CheckTargetMap = Readonly<Record<string, string | readonly string[]>>;

/**
 * Project-local plugin declarations — one list per plugin domain.
 *
 * When present in the config file, these override the default user-level
 * plugin directory (`~/.opensip-cli/<domain>/`). Plugins get installed
 * into `<project-root>/.opensip-cli/<domain>/` and are version-pinned
 * by the project rather than by each developer's machine.
 *
 * Each entry is any npm install spec: `@scope/pkg`, `@scope/pkg@^1.2.3`,
 * `./local-path`, `/abs/path/to/pkg.tgz`, `git+https://...`, etc.
 */
export interface PluginsConfig {
  readonly fit?: readonly string[];
  readonly sim?: readonly string[];
  /**
   * Explicit list of npm package names to load as check providers
   * (e.g. ['@opensip-cli/checks-python', '@my-org/checks-internal']).
   *
   * Marker-based discovery still runs alongside this list; use this for
   * packages that do not declare the full fit-pack marker/epoch block yet, or
   * when you want to name a package explicitly in config.
   *
   * Legacy: prefer manifest-driven `plugins.<key>` from capability
   * `discovery.configKeys.packages`. Retained for backward-compatible parsing.
   */
  readonly checkPackages?: readonly string[];
  /**
   * Exact simulation scenario package names to load from project `node_modules`.
   * When present, capability discovery treats the explicit set as the pinned
   * scenario source.
   *
   * Legacy: prefer manifest-driven `plugins.scenarioPackages`.
   */
  readonly scenarioPackages?: readonly string[];
  /**
   * Disable or enable simulation scenario name-pattern discovery.
   *
   * Legacy: prefer manifest-driven `plugins.autoDiscoverScenarios`.
   */
  readonly autoDiscoverScenarios?: boolean;
  /**
   * Additional npm scopes to include in simulation scenario-package
   * auto-discovery, on top of the platform default (`@opensip-cli`).
   *
   * Legacy: prefer manifest-driven `plugins.packageScopes`.
   */
  readonly packageScopes?: readonly string[];
  /**
   * Exact graph adapter package names to load from project `node_modules`.
   *
   * Legacy: prefer manifest-driven `plugins.graphAdapters`.
   */
  readonly graphAdapters?: readonly string[];
  /**
   * Disable or enable graph adapter marker discovery.
   *
   * Legacy: prefer manifest-driven `plugins.autoDiscoverGraphAdapters`.
   */
  readonly autoDiscoverGraphAdapters?: boolean;
  /**
   * Dynamic plugin-domain keys discovered from admitted tool manifests at
   * bootstrap (`createPluginsConfigSchema`). Values are either a string list
   * (`packages` / `scopes` kinds) or a boolean (`autoDiscover` kind).
   */
  readonly [domain: string]: readonly string[] | boolean | undefined;
}

/** The value shape expected for a capability discovery preference key. */
export type PluginConfigKeyKind = 'packages' | 'autoDiscover' | 'scopes';

/**
 * One `plugins.<key>` declared by an admitted tool capability descriptor. The CLI
 * maps manifest `capabilities[].discovery.configKeys` into this config-layer
 * shape, keeping core manifest types out of `@opensip-cli/config`.
 */
export interface PluginConfigKeyDeclaration {
  readonly key: string;
  readonly kind: PluginConfigKeyKind;
}

/**
 * Result of loading targets config, including both the target registry
 * and per-check target overrides.
 */
export interface TargetsConfig {
  /** Global file exclusion patterns (replaces .fitnessignore). */
  readonly globalExcludes: readonly string[];
  /** Per-check target overrides for third-party/marketplace checks. */
  readonly checkOverrides: CheckTargetMap;
  /**
   * Project-local plugin declarations, keyed by domain. When any domain
   * has entries here, plugin discovery for that domain reads from
   * `<project>/.opensip-cli/<domain>/` instead of `~/.opensip-cli/<domain>/`.
   */
  readonly plugins?: PluginsConfig;
}

// =============================================================================
// Field schemas (the document shape, in Zod) — single source for the loader,
// the signalers whole-doc schema, and the host declarations.
// =============================================================================

/** One named target's definition (a `targets.<name>` entry). Non-strict to
 *  match the historical fitness loader (unknown keys are stripped, not rejected). */
const conventionPathSchema = z.string().trim().min(1, 'convention path is required');

const targetConventionUsedExportSchema = z.object({
  file: conventionPathSchema,
  names: z.array(z.string().trim().min(1, 'export name is required')).min(1),
});

export const targetConventionsSchema = z.object({
  entrypoints: z.array(conventionPathSchema).optional(),
  alwaysUsed: z.array(conventionPathSchema).optional(),
  usedExports: z.array(targetConventionUsedExportSchema).optional(),
});

/** Return true when a target convention path is absolute or escapes upward. */
export function isUnsafeTargetConventionPath(pattern: string): boolean {
  const normalized = pattern.replaceAll('\\', '/');
  return (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  );
}

/** Return unsafe target convention paths without expanding globs. */
export function findUnsafeTargetConventionPaths(
  conventions: TargetConventionsConfig | undefined,
): readonly TargetConventionPathIssue[] {
  if (!conventions) return [];

  const issues: TargetConventionPathIssue[] = [];
  for (const pattern of conventions.entrypoints ?? []) {
    if (isUnsafeTargetConventionPath(pattern)) issues.push({ field: 'entrypoints', pattern });
  }
  for (const pattern of conventions.alwaysUsed ?? []) {
    if (isUnsafeTargetConventionPath(pattern)) issues.push({ field: 'alwaysUsed', pattern });
  }
  for (const usedExport of conventions.usedExports ?? []) {
    if (isUnsafeTargetConventionPath(usedExport.file)) {
      issues.push({ field: 'usedExports.file', pattern: usedExport.file });
    }
  }
  return issues;
}

/** Return an immutable copy of a target convention config block. */
export function freezeTargetConventions(
  conventions: TargetConventionsConfig,
): TargetConventionsConfig {
  return Object.freeze({
    ...(conventions.entrypoints && {
      entrypoints: Object.freeze([...conventions.entrypoints]),
    }),
    ...(conventions.alwaysUsed && {
      alwaysUsed: Object.freeze([...conventions.alwaysUsed]),
    }),
    ...(conventions.usedExports && {
      usedExports: Object.freeze(
        conventions.usedExports.map((entry) =>
          Object.freeze({
            file: entry.file,
            names: Object.freeze([...entry.names]),
          }),
        ),
      ),
    }),
  });
}

export const targetDefinitionSchema = z.object({
  description: z.string().min(1, 'description is required'),
  include: z.array(z.string()).min(1, 'at least one include pattern is required'),
  exclude: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  concerns: z.array(z.string()).optional(),
  conventions: targetConventionsSchema.optional(),
});

/** A `checkOverrides` value: a single target name or a non-empty list of them. */
export const checkTargetValueSchema = z.union([z.string(), z.array(z.string()).min(1)]);

/** The `targets:` block — a kebab-keyed record of target definitions. */
export const targetsRecordSchema = z.record(
  z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'target name must be kebab-case'),
  targetDefinitionSchema,
);

/** The `globalExcludes:` block — a list of glob patterns. */
export const globalExcludesSchema = z.array(z.string());

/** The `checkOverrides:` block — slug → target name(s). */
export const checkOverridesSchema = z.record(z.string(), checkTargetValueSchema);

const pluginStringArraySchema = z.array(z.string());

/**
 * Build the `plugins:` schema from the base project-local plugin domains plus
 * the capability preference keys declared by admitted tool manifests.
 */
export function createPluginsConfigSchema(
  keys: readonly PluginConfigKeyDeclaration[] = [],
): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {
    fit: pluginStringArraySchema.optional(),
    sim: pluginStringArraySchema.optional(),
  };

  for (const { key, kind } of keys) {
    shape[key] = (kind === 'autoDiscover' ? z.boolean() : pluginStringArraySchema).optional();
  }

  return z.object(shape).strict();
}

/** Base schema used by legacy loaders that do not have manifest context. */
export const pluginsConfigSchema = createPluginsConfigSchema([
  { key: 'checkPackages', kind: 'packages' },
  { key: 'scenarioPackages', kind: 'packages' },
  { key: 'autoDiscoverScenarios', kind: 'autoDiscover' },
  { key: 'packageScopes', kind: 'scopes' },
  { key: 'graphAdapters', kind: 'packages' },
  { key: 'autoDiscoverGraphAdapters', kind: 'autoDiscover' },
]);
