/**
 * @fileoverview Auto-discovery of `<scope>/scenarios-*` packages
 * installed in node_modules. The default scope is `@opensip-tools`;
 * customers can opt in additional scopes via `plugins.packageScopes`
 * so internal scenario packs published to their own scope (e.g.
 * `@acme/scenarios-*`) are discovered without per-package explicit
 * listing.
 *
 * Resolution rules (apply in order):
 *
 *   1. If `plugins.scenarioPackages` is declared in the project config,
 *      that explicit list wins. Auto-discovery is skipped entirely.
 *      Lets users pin their scenario set deterministically.
 *
 *   2. Else if `plugins.autoDiscoverScenarios: false` is declared,
 *      no additional scenario packages are loaded. Lets users opt out
 *      of dependency-based discovery.
 *
 *   3. Otherwise (default), scan node_modules under each configured
 *      scope (default scope plus any customer additions) for packages
 *      whose name matches `<scope>/scenarios-*` and return the list.
 *
 * No package is privileged. `plugins.packageScopes` is shared with
 * fitness's check-package discovery — a customer that lists `['@acme']`
 * once gets both `@acme/checks-*` and `@acme/scenarios-*` picked up,
 * which is the whole point of a single scope-level switch.
 *
 * The walker handles pnpm's nested node_modules layout: it looks at
 * the project's direct node_modules, then walks up to ancestor
 * node_modules (matching Node's resolution algorithm). We don't need
 * to recurse into transitive deps because scenario packages are
 * expected to be direct dependencies.
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { logger, readYamlFile, resolvePackageEntryPoint, resolveScopes } from '@opensip-tools/core'

const CONFIG_FILENAME = 'opensip-tools.config.yml'

const DEFAULT_SCOPE = '@opensip-tools'
const SCENARIOS_PREFIX = 'scenarios-'

export interface ScenarioPackageDiscoveryOptions {
  /** Absolute path to the project root (where opensip-tools.config.yml lives). */
  readonly projectDir: string
  /** Explicit list from `plugins.scenarioPackages` in the config. */
  readonly explicitPackages?: readonly string[]
  /** When false, auto-discovery is disabled. Default: true. */
  readonly autoDiscover?: boolean
  /**
   * Additional npm scopes to scan for scenario packs, on top of the
   * platform default (`@opensip-tools`). Customers list their own
   * scope here (e.g. `['@acme']`) to auto-discover internal packs
   * published to a private registry or linked into the workspace.
   * The default scope is always included; duplicates are deduplicated;
   * invalid entries (not matching `@kebab-case`) are skipped with a
   * warning. Shared field with fitness's check-package discovery.
   */
  readonly packageScopes?: readonly string[]
}

export interface DiscoveredScenarioPackage {
  /** npm package name, e.g. '@opensip-tools/scenarios-load-default'. */
  readonly name: string
  /** Absolute path to the package's directory inside node_modules. */
  readonly packageDir: string
}

/**
 * Resolve the list of scenario packages to load, applying the ordered
 * resolution rules in the file header. Returns every discovered
 * scenarios-* package; the sim loader imports them all uniformly,
 * with no package privileged over another.
 */
export function discoverScenarioPackages(
  options: ScenarioPackageDiscoveryOptions,
): DiscoveredScenarioPackage[] {
  const { projectDir, explicitPackages, autoDiscover = true, packageScopes = [] } = options

  // Rule 1: explicit list wins
  if (explicitPackages !== undefined) {
    if (explicitPackages.length === 0) {
      return []
    }
    const out: DiscoveredScenarioPackage[] = []
    for (const name of explicitPackages) {
      const dir = resolvePackageDir(projectDir, name)
      if (dir) {
        out.push({ name, packageDir: dir })
      } else {
        logger.warn({
          evt: 'plugin.scenario_package.not_resolved',
          module: 'core:plugins',
          name,
          msg: `Configured scenario package "${name}" is not installed in node_modules — skipping`,
        })
      }
    }
    return out
  }

  // Rule 2: opt-out
  if (!autoDiscover) {
    return []
  }

  // Rule 3: auto-discover under default + customer-configured scopes
  const scopes = resolveScopes(DEFAULT_SCOPE, packageScopes, 'plugin.scenario_package.invalid_scope')
  return autoDiscoverScenarios(projectDir, scopes)
}

/**
 * Walk up the directory tree from `projectDir` looking for
 * `node_modules/<scope>/` directories under every configured scope,
 * and return all `scenarios-*` package directories found across them.
 * Mirrors Node's module resolution (any ancestor node_modules counts),
 * which handles pnpm hoisting and monorepo layouts where the scope may
 * live in the workspace root.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- ancestor-walk discovery: walks node_modules trees up the directory tree until the filesystem root
function autoDiscoverScenarios(
  projectDir: string,
  scopes: readonly string[],
): DiscoveredScenarioPackage[] {
  const seen = new Set<string>()
  const out: DiscoveredScenarioPackage[] = []
  let dir = projectDir
  let prev = ''
  while (dir !== prev) {
    for (const scope of scopes) {
      const scopeDir = join(dir, 'node_modules', scope)
      if (!existsSync(scopeDir)) continue
      for (const entry of safeReaddir(scopeDir)) {
        if (!entry.startsWith(SCENARIOS_PREFIX)) continue
        const name = `${scope}/${entry}`
        if (seen.has(name)) continue
        const packageDir = join(scopeDir, entry)
        if (!hasPackageJson(packageDir)) continue
        seen.add(name)
        out.push({ name, packageDir })
      }
    }
    prev = dir
    dir = dirname(dir)
  }
  return out
}

function resolvePackageDir(projectDir: string, name: string): string | undefined {
  let dir = projectDir
  let prev = ''
  while (dir !== prev) {
    const candidate = join(dir, 'node_modules', name)
    if (hasPackageJson(candidate)) return candidate
    prev = dir
    dir = dirname(dir)
  }
  return undefined
}

function hasPackageJson(packageDir: string): boolean {
  if (!existsSync(packageDir)) return false
  return existsSync(join(packageDir, 'package.json'))
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Read `name` and `main`/`exports` from a package.json. Used by the
 * sim loader to resolve the entry point of a discovered scenario
 * package.
 */
export interface ScenarioPackageMetadata {
  readonly name: string
  readonly mainEntry: string
}

/**
 * Read `plugins.scenarioPackages`, `plugins.autoDiscoverScenarios`,
 * and `plugins.packageScopes` from the project's opensip-tools.config.yml
 * without doing a full schema parse. Returns the raw values so callers
 * can apply the resolution rules in `discoverScenarioPackages()`.
 *
 * Mirrors the inline-yaml-read pattern used by readProjectPluginsList()
 * and fitness's readCheckPackagePreferences().
 */
export function readScenarioPackagePreferences(projectDir: string): {
  readonly scenarioPackages?: readonly string[]
  readonly autoDiscoverScenarios?: boolean
  readonly packageScopes?: readonly string[]
} {
  const configPath = join(projectDir, CONFIG_FILENAME)
  const doc = readYamlFile(configPath)
  if (!doc || typeof doc !== 'object') return {}
  const plugins = (doc as Record<string, unknown>).plugins
  if (!plugins || typeof plugins !== 'object') return {}
  const p = plugins as Record<string, unknown>
  const result: {
    scenarioPackages?: readonly string[]
    autoDiscoverScenarios?: boolean
    packageScopes?: readonly string[]
  } = {}
  if (Array.isArray(p.scenarioPackages)) {
    result.scenarioPackages = p.scenarioPackages.filter((v): v is string => typeof v === 'string')
  }
  if (typeof p.autoDiscoverScenarios === 'boolean') {
    result.autoDiscoverScenarios = p.autoDiscoverScenarios
  }
  if (Array.isArray(p.packageScopes)) {
    result.packageScopes = p.packageScopes.filter((v): v is string => typeof v === 'string')
  }
  return result
}

export function readScenarioPackageMetadata(packageDir: string): ScenarioPackageMetadata | undefined {
  const resolved = resolvePackageEntryPoint(packageDir)
  if (!resolved) return undefined
  return { name: resolved.name, mainEntry: resolved.entry }
}
