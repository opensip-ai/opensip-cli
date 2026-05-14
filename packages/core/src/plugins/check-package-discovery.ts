/**
 * @fileoverview Auto-discovery of @opensip-tools/checks-* packages
 * installed in node_modules.
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
 *   3. Otherwise (default), scan node_modules for any package whose
 *      name matches `@opensip-tools/checks-*` and return the list.
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

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { logger } from '../lib/logger.js'

const CONFIG_FILENAME = 'opensip-tools.config.yml'

// Bridge ESM ↔ CJS: createRequire bound to this module's URL gives us a
// `require` that resolves js-yaml from this package's own deps. The bare
// `require('js-yaml')` form fails in ESM because no global require is
// present; using createRequire(import.meta.url) is the supported escape
// hatch.
const requireFromHere = createRequire(import.meta.url)

const SCOPE = '@opensip-tools'
const CHECKS_PREFIX = 'checks-'

export interface CheckPackageDiscoveryOptions {
  /** Absolute path to the project root (where opensip-tools.config.yml lives). */
  readonly projectDir: string
  /** Explicit list from `plugins.checkPackages` in the config. */
  readonly explicitPackages?: readonly string[]
  /** When false, auto-discovery is disabled. Default: true. */
  readonly autoDiscover?: boolean
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
  const { projectDir, explicitPackages, autoDiscover = true } = options

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

  // Rule 3: auto-discover
  return autoDiscoverChecks(projectDir)
}

/**
 * Walk up the directory tree from `projectDir` looking for the first
 * `node_modules/@opensip-tools/` directory and return all `checks-*`
 * package directories found there. Mirrors Node's module resolution
 * (any ancestor node_modules counts), which handles pnpm hoisting and
 * monorepo layouts where the scope may live in the workspace root.
 */
function autoDiscoverChecks(projectDir: string): DiscoveredCheckPackage[] {
  const seen = new Set<string>()
  const out: DiscoveredCheckPackage[] = []
  let dir = projectDir
  let prev = ''
  while (dir !== prev) {
    const scopeDir = join(dir, 'node_modules', SCOPE)
    if (existsSync(scopeDir)) {
      for (const entry of safeReaddir(scopeDir)) {
        if (!entry.startsWith(CHECKS_PREFIX)) continue
        const name = `${SCOPE}/${entry}`
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
 * Read the `plugins.checkPackages` and `plugins.autoDiscoverChecks`
 * fields from the project's opensip-tools.config.yml without doing a
 * full schema parse. Returns the raw values so callers can apply the
 * resolution rules in `discoverCheckPackages()`.
 *
 * Mirrors the inline-yaml-read pattern used by readProjectPluginsList()
 * — avoids a circular dep between plugins/ and targets/.
 */
export function readCheckPackagePreferences(projectDir: string): {
  readonly checkPackages?: readonly string[]
  readonly autoDiscoverChecks?: boolean
} {
  const configPath = join(projectDir, CONFIG_FILENAME)
  if (!existsSync(configPath)) return {}
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const yaml = requireFromHere('js-yaml') as { load: (s: string) => unknown }
    const doc = yaml.load(raw) as Record<string, unknown> | null
    if (!doc || typeof doc !== 'object') return {}
    const plugins = doc['plugins']
    if (!plugins || typeof plugins !== 'object') return {}
    const p = plugins as Record<string, unknown>
    const result: { checkPackages?: readonly string[]; autoDiscoverChecks?: boolean } = {}
    if (Array.isArray(p.checkPackages)) {
      result.checkPackages = p.checkPackages.filter((v): v is string => typeof v === 'string')
    }
    if (typeof p.autoDiscoverChecks === 'boolean') {
      result.autoDiscoverChecks = p.autoDiscoverChecks
    }
    return result
  } catch {
    return {}
  }
}

export function readCheckPackageMetadata(packageDir: string): CheckPackageMetadata | undefined {
  const pkgPath = join(packageDir, 'package.json')
  if (!existsSync(pkgPath)) return undefined
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      name?: string
      main?: string
      exports?: Record<string, unknown> | string
    }
    if (!pkg.name) return undefined
    let mainEntry: string | undefined
    const exports = pkg.exports
    if (typeof exports === 'string') {
      mainEntry = exports
    } else if (exports && typeof exports === 'object' && '.' in exports) {
      const dot = exports['.']
      if (typeof dot === 'string') {
        mainEntry = dot
      } else if (dot && typeof dot === 'object') {
        const obj = dot as Record<string, unknown>
        if (typeof obj.import === 'string') mainEntry = obj.import
        else if (typeof obj.default === 'string') mainEntry = obj.default
      }
    }
    if (!mainEntry && typeof pkg.main === 'string') {
      mainEntry = pkg.main
    }
    if (!mainEntry) {
      mainEntry = './index.js'
    }
    return { name: pkg.name, mainEntry: join(packageDir, mainEntry) }
  } catch {
    return undefined
  }
}
