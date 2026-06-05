/**
 * @fileoverview Target type definitions for shared targeting
 */

/** Configuration for a named target (file set with include/exclude globs). */
export interface TargetConfig {
  /** Kebab-case identifier, e.g. 'backend', 'module-foundation' */
  readonly name: string
  /** Human-readable description */
  readonly description: string
  /** Glob patterns to include */
  readonly include: readonly string[]
  /** Glob patterns to exclude */
  readonly exclude: readonly string[]
  /** Tags for filtering/grouping */
  readonly tags?: readonly string[]
  /** Languages this target contains (e.g. 'typescript', 'tsx', 'json') */
  readonly languages?: readonly string[]
  /** Semantic concerns this target represents (e.g. 'backend', 'server', 'api') */
  readonly concerns?: readonly string[]
}

/** A resolved target wrapping its configuration. */
export interface Target {
  readonly config: TargetConfig
}

/**
 * Per-check target overrides.
 * Maps check slug → target name(s) to restrict which files a check runs against.
 */
type CheckTargetMap = Readonly<Record<string, string | readonly string[]>>

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
interface PluginsConfig {
  readonly fit?: readonly string[]
  readonly sim?: readonly string[]
  readonly lang?: readonly string[]
  /**
   * Explicit list of npm package names to load as check providers
   * (e.g. ['@opensip-tools/checks-python', '@my-org/checks-internal']).
   *
   * Marker-based discovery still runs alongside this list; use this for
   * packages that do not declare `opensipTools.kind: "fit-pack"` yet, or
   * when you want to name a package explicitly in config.
   */
  readonly checkPackages?: readonly string[]
  /**
   * Additional npm scopes to include in simulation scenario-package
   * auto-discovery, on top of the platform default (`@opensip-tools`).
   * Lets customers publish internal sim scenario packs under their own scope
   * (e.g. `['@acme']` to discover `@acme/scenarios-*`) without listing each
   * package individually.
   *
   * For sim discovery: ignored when `scenarioPackages` is set or
   * `autoDiscoverScenarios` is false.
   */
  readonly packageScopes?: readonly string[]
}

/**
 * Result of loading targets config, including both the target registry
 * and per-check target overrides.
 */
export interface TargetsConfig {
  /** Global file exclusion patterns (replaces .fitnessignore). */
  readonly globalExcludes: readonly string[]
  /** Per-check target overrides for third-party/marketplace checks. */
  readonly checkOverrides: CheckTargetMap
  /**
   * Project-local plugin declarations, keyed by domain. When any domain
   * has entries here, plugin discovery for that domain reads from
   * `<project>/.opensip-tools/<domain>/` instead of `~/.opensip-tools/<domain>/`.
   * Absent (or undefined per-domain) = fall back to the user-level dir
   * for that domain.
   */
  readonly plugins?: PluginsConfig
}
