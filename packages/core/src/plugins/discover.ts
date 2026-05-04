/**
 * @fileoverview Plugin discovery for ~/.opensip-tools/{fit,sim,asm}/
 *
 * Scans for npm packages in node_modules/ and loose .js/.mjs files.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, basename, extname, sep } from 'node:path'
import { homedir } from 'node:os'

import { logger } from '../lib/logger.js'

import type { DiscoveredPlugin, PluginDomain } from './types.js'

const DEFAULT_BASE_DIR = join(homedir(), '.opensip-tools')
const CONFIG_FILENAME = 'opensip-tools.config.yml'

/** Get the absolute path to a user-level plugin domain directory. */
export function getPluginDir(domain: PluginDomain, baseDir?: string): string {
  return join(baseDir ?? DEFAULT_BASE_DIR, domain)
}

/** Get the user-level base directory for all plugins. */
export function getBaseDir(baseDir?: string): string {
  return baseDir ?? DEFAULT_BASE_DIR
}

/** Absolute path to the project-local plugin dir for a given domain. */
export function getProjectPluginDir(projectDir: string, domain: PluginDomain): string {
  return join(projectDir, '.opensip-tools', domain)
}

/**
 * Resolve the plugin dir to use for a given domain + project.
 *
 * Precedence:
 *   1. Project-local (`<projectDir>/.opensip-tools/<domain>/`) IF the
 *      project's `opensip-tools.config.yml` declares a non-empty
 *      `plugins.<domain>` section.
 *   2. User-level (`~/.opensip-tools/<domain>/`) otherwise.
 *
 * Project-local takes precedence when opted in, so a project's plugin
 * set is reproducible across developers and CI. The user-level dir
 * remains the default so projects that don't declare plugins keep
 * the original behavior.
 *
 * @param domain      One of `fit` / `sim` / `asm`.
 * @param projectDir  Absolute path to the project root. When undefined,
 *                    always returns the user-level dir.
 * @param baseDir     Override the user-level base (primarily for tests).
 */
export function resolvePluginDir(
  domain: PluginDomain,
  projectDir?: string,
  baseDir?: string,
): { dir: string; source: 'project' | 'user' } {
  if (projectDir && hasProjectPluginsDeclared(projectDir, domain)) {
    return { dir: getProjectPluginDir(projectDir, domain), source: 'project' }
  }
  return { dir: getPluginDir(domain, baseDir), source: 'user' }
}

/** True when the project config declares at least one plugin in `plugins.<domain>`. */
export function hasProjectPluginsDeclared(projectDir: string, domain: PluginDomain): boolean {
  const list = readProjectPluginsList(projectDir, domain)
  return list !== undefined && list.length > 0
}

/**
 * Read the declared plugin list for a domain from the project config.
 * Returns undefined when the config is absent, unreadable, or has no
 * entry for the domain. Does NOT throw on YAML parse errors — returns
 * undefined so discovery falls back to the user-level dir and the
 * config-layer schema validation surfaces the parse error on its own
 * path (avoids double-reporting).
 */
export function readProjectPluginsList(
  projectDir: string,
  domain: PluginDomain,
): readonly string[] | undefined {
  const configPath = join(projectDir, CONFIG_FILENAME)
  if (!existsSync(configPath)) return undefined
  try {
    // Parse YAML inline to avoid a circular dep between plugins/ and targets/.
    // We only need the `plugins.<domain>` array; anything else is
    // validated by the targets loader.
    const raw = readFileSync(configPath, 'utf-8')
    // Minimal YAML parse — defer to the shared yaml dep.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('js-yaml') as { load: (s: string) => unknown }
    const doc = yaml.load(raw) as Record<string, unknown> | null
    if (!doc || typeof doc !== 'object') return undefined
    const plugins = doc['plugins']
    if (!plugins || typeof plugins !== 'object') return undefined
    const list = (plugins as Record<string, unknown>)[domain]
    if (!Array.isArray(list)) return undefined
    return list.filter((v): v is string => typeof v === 'string')
  } catch {
    return undefined
  }
}

/**
 * Discover all plugins in a domain directory.
 * Returns discovered plugins sorted: packages first, then files.
 *
 * When `projectDir` is passed AND the project declares plugins in
 * `opensip-tools.config.yml` under `plugins.<domain>`, scans the
 * project-local dir (`<projectDir>/.opensip-tools/<domain>/`).
 * Otherwise falls back to `~/.opensip-tools/<domain>/`.
 */
export function discoverPlugins(
  domain: PluginDomain,
  baseDir?: string,
  projectDir?: string,
): DiscoveredPlugin[] {
  const { dir } = resolvePluginDir(domain, projectDir, baseDir)
  if (!existsSync(dir)) return []

  const plugins: DiscoveredPlugin[] = []

  // 1. Discover npm packages declared as direct dependencies of the plugin
  //    dir's package.json. Transitive deps under node_modules/ are skipped
  //    so unrelated packages (peers, their deps) aren't treated as plugins.
  const nodeModulesDir = join(dir, 'node_modules')
  if (existsSync(nodeModulesDir)) {
    plugins.push(...discoverNpmPackages(nodeModulesDir, dir))
  }

  // 2. Discover loose JS/MJS files
  plugins.push(...discoverLooseFiles(dir))

  logger.info({
    evt: 'plugin.loader.discover',
    module: 'core:plugins',
    domain,
    packageCount: plugins.filter(p => p.type === 'package').length,
    fileCount: plugins.filter(p => p.type === 'file').length,
  })

  return plugins
}

// =============================================================================
// NPM PACKAGE DISCOVERY
// =============================================================================

function discoverNpmPackages(nodeModulesDir: string, pluginDir: string): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = []

  const declared = readDeclaredDependencies(pluginDir)
  if (declared.length === 0) return plugins

  for (const name of declared) {
    // Reject names that could traverse before they ever touch the filesystem.
    // The plugin dir's package.json is user-controlled (and edited directly
    // by `plugin add` / hand edits), so dependency keys are an attacker-
    // influenced input flowing into a path join.
    if (name.length === 0 || name.includes('..') || name.startsWith('/') || name.includes('\0')) {
      logger.warn({
        evt: 'plugin.loader.discover.reject',
        module: 'core:plugins',
        reason: 'invalid dependency name',
        name,
      })
      continue
    }
    const packageDir = join(nodeModulesDir, name)
    // Containment check: resolved path (after any symlinks) must stay inside
    // node_modules. This catches both string-level traversal that survives
    // path.join (none currently, but defense-in-depth) and symlink-based
    // escapes if an attacker can plant a symlink in node_modules itself.
    if (!isPathInside(packageDir, nodeModulesDir)) {
      logger.warn({
        evt: 'plugin.loader.discover.reject',
        module: 'core:plugins',
        reason: 'package path resolves outside node_modules',
        name,
      })
      continue
    }
    const plugin = tryDiscoverPackage(packageDir, name)
    if (plugin) plugins.push(plugin)
  }

  return plugins
}

/**
 * Read the plugin dir's package.json and return direct-dependency names.
 * Only these are treated as plugins — transitive deps in node_modules/
 * (such as peer deps of plugins, or their transitive installs) are ignored.
 */
function readDeclaredDependencies(pluginDir: string): string[] {
  const pkgJsonPath = join(pluginDir, 'package.json')
  if (!existsSync(pkgJsonPath)) return []
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { dependencies?: Record<string, string> }
    return Object.keys(pkg.dependencies ?? {})
  } catch {
    return []
  }
}

function tryDiscoverPackage(packageDir: string, name: string): DiscoveredPlugin | undefined {
  if (!safeIsDirectory(packageDir)) return undefined

  const pkgJsonPath = join(packageDir, 'package.json')
  if (!existsSync(pkgJsonPath)) return undefined

  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>
    const packageName = (pkgJson.name as string) ?? name

    // Determine entry point: exports['.'] > main > index.js
    let entryPoint: string | undefined
    const exports = pkgJson.exports as Record<string, unknown> | string | undefined
    if (typeof exports === 'string') {
      entryPoint = join(packageDir, exports)
    } else if (exports && typeof exports === 'object' && '.' in exports) {
      const dotExport = exports['.']
      if (typeof dotExport === 'string') {
        entryPoint = join(packageDir, dotExport)
      } else if (dotExport && typeof dotExport === 'object') {
        // Handle { '.': { import: './dist/index.js' } }
        const imp = (dotExport as Record<string, unknown>).import ?? (dotExport as Record<string, unknown>).default
        if (typeof imp === 'string') entryPoint = join(packageDir, imp)
      }
    }
    if (!entryPoint && typeof pkgJson.main === 'string') {
      entryPoint = join(packageDir, pkgJson.main)
    }
    if (!entryPoint) {
      entryPoint = join(packageDir, 'index.js')
    }

    if (!existsSync(entryPoint)) {
      logger.debug({
        evt: 'plugin.loader.discover.skip',
        module: 'core:plugins',
        reason: 'entry point not found',
        packageName,
        entryPoint,
      })
      return undefined
    }

    return {
      type: 'package',
      entryPoint,
      namespace: packageName,
      source: packageName,
    }
  } catch {
    logger.debug({
      evt: 'plugin.loader.discover.skip',
      module: 'core:plugins',
      reason: 'invalid package.json',
      name,
    })
    return undefined
  }
}

// =============================================================================
// LOOSE FILE DISCOVERY
// =============================================================================

const LOOSE_FILE_EXTENSIONS = new Set(['.js', '.mjs'])

function discoverLooseFiles(dir: string): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return plugins
  }

  for (const entry of entries) {
    const ext = extname(entry)
    if (!LOOSE_FILE_EXTENSIONS.has(ext)) continue

    const fullPath = join(dir, entry)
    if (!safeIsFile(fullPath)) continue

    // Containment check: a symlink in the plugin dir pointing outside it
    // would otherwise be dynamically imported, executing arbitrary code from
    // wherever the symlink leads. statSync follows symlinks (intentionally —
    // pnpm uses symlinks inside node_modules for legitimate reasons), so we
    // verify the real path stays inside the plugin dir.
    if (!isPathInside(fullPath, dir)) {
      logger.warn({
        evt: 'plugin.loader.discover.reject',
        module: 'core:plugins',
        reason: 'loose file resolves outside plugin dir',
        entry,
      })
      continue
    }

    const name = basename(entry, ext)

    plugins.push({
      type: 'file',
      entryPoint: fullPath,
      namespace: name,
      source: entry,
    })
  }

  return plugins
}

// =============================================================================
// HELPERS
// =============================================================================

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Returns true iff `child`, after resolving symlinks, is the same path as
 * `parent` or located inside it. Used as a security boundary check against
 * attacker-influenced paths in plugin discovery: a malicious package.json
 * dependency key (`"../../etc/passwd"`) or a symlink planted in the plugin
 * dir would pass `existsSync` / `statSync` but fail this check.
 *
 * Both paths are resolved with `realpathSync`, so the comparison reflects
 * the real filesystem location regardless of intermediate symlinks. If
 * either path can't be resolved (doesn't exist, permission denied), we
 * fail closed and return false.
 */
function isPathInside(child: string, parent: string): boolean {
  let realChild: string
  let realParent: string
  try {
    realChild = realpathSync(child)
    realParent = realpathSync(parent)
  } catch {
    return false
  }
  if (realChild === realParent) return true
  return realChild.startsWith(realParent + sep)
}
