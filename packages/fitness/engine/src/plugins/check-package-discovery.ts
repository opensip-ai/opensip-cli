/**
 * @fileoverview Auto-discovery of `<scope>/checks-*` packages installed
 * in node_modules. The default scope is `@opensip-tools`; customers
 * can opt in additional scopes via `plugins.packageScopes` so internal
 * check packs published to their own scope (e.g. `@acme/checks-*`)
 * are discovered without per-package explicit listing.
 *
 * Resolution rules (apply in order):
 *
 *   1. If `plugins.checkPackages` is declared in the project config,
 *      that explicit list wins. Auto-discovery is skipped entirely.
 *      Lets users pin their check set deterministically.
 *
 *   2. Else if `plugins.autoDiscoverChecks: false` is declared,
 *      no additional check packages are loaded. Lets users opt out
 *      of dependency-based discovery (e.g. when running in an
 *      environment with unrelated @opensip-tools packages installed).
 *
 *   3. Otherwise (default), scan node_modules under each configured
 *      scope (default scope plus any customer additions) for packages
 *      whose name matches `<scope>/checks-*` and return the list.
 *
 * No package is privileged — what used to be `checks-builtin` is now
 * just one of many `@opensip-tools/checks-*` packages declared as
 * ordinary CLI dependencies and discovered uniformly. The CLI no
 * longer hardcodes any check package import.
 *
 * The walker handles pnpm's nested node_modules layout: it looks at
 * the project's direct node_modules, then walks up to ancestor
 * node_modules (matching Node's resolution algorithm). We don't need
 * to recurse into transitive deps because check packages are expected
 * to be direct dependencies.
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { logger, readYamlFile, resolvePackageEntryPoint } from '@opensip-tools/core'

const CONFIG_FILENAME = 'opensip-tools.config.yml'

const DEFAULT_SCOPE = '@opensip-tools'
const CHECKS_PREFIX = 'checks-'

// npm scope syntax: `@` followed by a kebab-case identifier. We anchor
// strictly because scope strings end up in `path.join('node_modules', scope)`
// — a stray `..` or `/` would scan the wrong directory.
const VALID_SCOPE = /^@[a-z0-9][a-z0-9._-]*$/

export interface CheckPackageDiscoveryOptions {
  /** Absolute path to the project root (where opensip-tools.config.yml lives). */
  readonly projectDir: string
  /** Explicit list from `plugins.checkPackages` in the config. */
  readonly explicitPackages?: readonly string[]
  /** When false, auto-discovery is disabled. Default: true. */
  readonly autoDiscover?: boolean
  /**
   * Additional npm scopes to scan for check packs, on top of the
   * platform default (`@opensip-tools`). Customers list their own
   * scope here (e.g. `['@acme']`) to auto-discover internal packs
   * published to a private registry or linked into the workspace.
   * The default scope is always included; duplicates are deduplicated;
   * invalid entries (not matching `@kebab-case`) are skipped with a
   * warning.
   */
  readonly packageScopes?: readonly string[]
}

export interface DiscoveredCheckPackage {
  /** npm package name, e.g. '@opensip-tools/checks-python'. */
  readonly name: string
  /** Absolute path to the package's directory inside node_modules. */
  readonly packageDir: string
}

/**
 * Resolve the list of check packages to load, applying the ordered
 * resolution rules in the file header. Returns every discovered
 * @opensip-tools/checks-* package; the CLI loads them all uniformly,
 * with no package privileged over another.
 */
export function discoverCheckPackages(
  options: CheckPackageDiscoveryOptions,
): DiscoveredCheckPackage[] {
  const { projectDir, explicitPackages, autoDiscover = true, packageScopes = [] } = options

  // Rule 1: explicit list wins
  if (explicitPackages !== undefined) {
    if (explicitPackages.length === 0) {
      return []
    }
    const out: DiscoveredCheckPackage[] = []
    for (const name of explicitPackages) {
      const dir = resolvePackageDir(projectDir, name)
      if (dir) {
        out.push({ name, packageDir: dir })
      } else {
        logger.warn({
          evt: 'plugin.check_package.not_resolved',
          module: 'core:plugins',
          name,
          msg: `Configured check package "${name}" is not installed in node_modules — skipping`,
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
  return autoDiscoverChecks(projectDir, resolveScopes(packageScopes))
}

/**
 * Resolve the effective scope list: the platform default is always
 * included; customer additions are appended after deduplication and
 * format validation. Invalid scope strings are dropped with a warning
 * rather than throwing — consistent with how this module handles
 * unresolved explicit packages elsewhere.
 */
function resolveScopes(extra: readonly string[]): readonly string[] {
  const out: string[] = [DEFAULT_SCOPE]
  const seen = new Set<string>(out)
  for (const scope of extra) {
    if (!VALID_SCOPE.test(scope)) {
      logger.warn({
        evt: 'plugin.check_package.invalid_scope',
        module: 'core:plugins',
        scope,
        msg: `plugins.packageScopes entry "${scope}" is not a valid npm scope (expected "@kebab-case") — skipping`,
      })
      continue
    }
    if (seen.has(scope)) continue
    seen.add(scope)
    out.push(scope)
  }
  return out
}

/**
 * Walk up the directory tree from `projectDir` looking for
 * `node_modules/<scope>/` directories under every configured scope,
 * and return all `checks-*` package directories found across them.
 * Mirrors Node's module resolution (any ancestor node_modules counts),
 * which handles pnpm hoisting and monorepo layouts where the scope may
 * live in the workspace root.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- ancestor-walk discovery: walks node_modules trees up the directory tree until the filesystem root
function autoDiscoverChecks(
  projectDir: string,
  scopes: readonly string[],
): DiscoveredCheckPackage[] {
  const seen = new Set<string>()
  const out: DiscoveredCheckPackage[] = []
  let dir = projectDir
  let prev = ''
  while (dir !== prev) {
    for (const scope of scopes) {
      const scopeDir = join(dir, 'node_modules', scope)
      if (!existsSync(scopeDir)) continue
      for (const entry of safeReaddir(scopeDir)) {
        if (!entry.startsWith(CHECKS_PREFIX)) continue
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
 * Read `name` and `main`/`exports` from a package.json. Used by the CLI
 * to resolve the entry point of a discovered check package.
 */
export interface CheckPackageMetadata {
  readonly name: string
  readonly mainEntry: string
}

/**
 * Read `plugins.checkPackages`, `plugins.autoDiscoverChecks`, and
 * `plugins.packageScopes` from the project's opensip-tools.config.yml
 * without doing a full schema parse. Returns the raw values so callers
 * can apply the resolution rules in `discoverCheckPackages()`.
 *
 * Mirrors the inline-yaml-read pattern used by readProjectPluginsList()
 * — avoids a circular dep between plugins/ and targets/.
 */
export function readCheckPackagePreferences(projectDir: string): {
  readonly checkPackages?: readonly string[]
  readonly autoDiscoverChecks?: boolean
  readonly packageScopes?: readonly string[]
} {
  const configPath = join(projectDir, CONFIG_FILENAME)
  const doc = readYamlFile(configPath)
  if (!doc || typeof doc !== 'object') return {}
  const plugins = (doc as Record<string, unknown>).plugins
  if (!plugins || typeof plugins !== 'object') return {}
  const p = plugins as Record<string, unknown>
  const result: {
    checkPackages?: readonly string[]
    autoDiscoverChecks?: boolean
    packageScopes?: readonly string[]
  } = {}
  if (Array.isArray(p.checkPackages)) {
    result.checkPackages = p.checkPackages.filter((v): v is string => typeof v === 'string')
  }
  if (typeof p.autoDiscoverChecks === 'boolean') {
    result.autoDiscoverChecks = p.autoDiscoverChecks
  }
  if (Array.isArray(p.packageScopes)) {
    result.packageScopes = p.packageScopes.filter((v): v is string => typeof v === 'string')
  }
  return result
}

export function readCheckPackageMetadata(packageDir: string): CheckPackageMetadata | undefined {
  const resolved = resolvePackageEntryPoint(packageDir)
  if (!resolved) return undefined
  return { name: resolved.name, mainEntry: resolved.entry }
}
