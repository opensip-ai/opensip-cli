/**
 * targeting — the shared two-layer scope model: the `targets:`,
 * `globalExcludes:`, and `checkOverrides:` document-level blocks of
 * `opensip-tools.config.yml`.
 *
 * This is cross-tool config, not a fitness concern — a project shipping only
 * `graph` resolves its scope through the same model. Relocated here from
 * `@opensip-tools/fitness` in 2.10.1 (ADR-0023). The data/runtime boundary:
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
 * plugin directory (`~/.opensip-tools/<domain>/`). Plugins get installed
 * into `<project-root>/.opensip-tools/<domain>/` and are version-pinned
 * by the project rather than by each developer's machine.
 *
 * Each entry is any npm install spec: `@scope/pkg`, `@scope/pkg@^1.2.3`,
 * `./local-path`, `/abs/path/to/pkg.tgz`, `git+https://...`, etc.
 */
export interface PluginsConfig {
  readonly fit?: readonly string[];
  readonly sim?: readonly string[];
  readonly lang?: readonly string[];
  /**
   * Explicit list of npm package names to load as check providers
   * (e.g. ['@opensip-tools/checks-python', '@my-org/checks-internal']).
   *
   * Marker-based discovery still runs alongside this list; use this for
   * packages that do not declare `opensipTools.kind: "fit-pack"` yet, or
   * when you want to name a package explicitly in config.
   */
  readonly checkPackages?: readonly string[];
  /**
   * Exact simulation scenario package names to load from project `node_modules`.
   * When present, capability discovery treats the explicit set as the pinned
   * scenario source.
   */
  readonly scenarioPackages?: readonly string[];
  /** Disable or enable simulation scenario name-pattern discovery. */
  readonly autoDiscoverScenarios?: boolean;
  /**
   * Additional npm scopes to include in simulation scenario-package
   * auto-discovery, on top of the platform default (`@opensip-tools`).
   */
  readonly packageScopes?: readonly string[];
  /** Exact graph adapter package names to load from project `node_modules`. */
  readonly graphAdapters?: readonly string[];
  /** Disable or enable graph adapter marker discovery. */
  readonly autoDiscoverGraphAdapters?: boolean;
}

/** The value shape expected for a capability discovery preference key. */
export type PluginConfigKeyKind = 'packages' | 'autoDiscover' | 'scopes';

/**
 * One `plugins.<key>` declared by an admitted tool capability descriptor. The CLI
 * maps manifest `capabilities[].discovery.configKeys` into this config-layer
 * shape, keeping core manifest types out of `@opensip-tools/config`.
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
   * `<project>/.opensip-tools/<domain>/` instead of `~/.opensip-tools/<domain>/`.
   */
  readonly plugins?: PluginsConfig;
}

// =============================================================================
// Field schemas (the document shape, in Zod) — single source for the loader,
// the signalers whole-doc schema, and the host declarations.
// =============================================================================

/** One named target's definition (a `targets.<name>` entry). Non-strict to
 *  match the historical fitness loader (unknown keys are stripped, not rejected). */
export const targetDefinitionSchema = z.object({
  description: z.string().min(1, 'description is required'),
  include: z.array(z.string()).min(1, 'at least one include pattern is required'),
  exclude: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  concerns: z.array(z.string()).optional(),
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
    lang: pluginStringArraySchema.optional(),
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
