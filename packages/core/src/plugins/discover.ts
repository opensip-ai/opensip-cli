/**
 * @fileoverview Plugin discovery for the project-local layout.
 *
 * Two artifact sources are walked per fit/sim domain:
 *
 *   1. USER SOURCE — `<project>/opensip-tools/<tool>/<kind>/*.{js,mjs}`
 *      where `<kind>` is `checks`/`recipes` for fit, or
 *      `scenarios`/`recipes` for sim. Auto-loaded by directory presence;
 *      no config opt-in.
 *
 *   2. NPM PLUGINS — packages installed under
 *      `<project>/opensip-tools/.runtime/plugins/<domain>/node_modules/`
 *      whose names appear in the project's
 *      `opensip-tools.config.yml#plugins.<domain>: [...]`. The explicit
 *      list is required so a `plugin install` step is intentional, not
 *      an accidental load of every transitive devDep.
 *
 * Other domains (`'lang'` for language adapters; `'asm'` reserved for
 * a future tool) don't have project-local plugin dirs — they return
 * an empty array. Language adapters ship as direct deps of the CLI;
 * assess is not yet implemented.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, basename, extname, sep } from 'node:path'

import { logger } from '../lib/logger.js'
import { resolveProjectPaths } from '../lib/paths.js'

import type { DiscoveredPlugin, PluginDomain } from './types.js'

const CONFIG_FILENAME = 'opensip-tools.config.yml'

/** Logger module tag used by every event in this file. */
const MODULE_TAG = 'core:plugins'

// Bridge ESM ↔ CJS to load js-yaml from this package's deps without
// relying on a (nonexistent) global `require` in ESM context.
const requireFromHere = createRequire(import.meta.url)

/**
 * User-source subdirectories per fit/sim domain. Each entry walks
 * a different artifact type. Domains other than fit/sim have no
 * subdirs and discoverPlugins() returns empty for them.
 */
const USER_SUBDIRS: Partial<Record<PluginDomain, readonly string[]>> = {
  fit: ['checks', 'recipes'],
  sim: ['scenarios', 'recipes'],
}

// =============================================================================
// PUBLIC ENTRY POINT
// =============================================================================

/**
 * Discover all plugins for a domain in the project layout.
 *
 * Returns a list of `DiscoveredPlugin` entries (loose .mjs files +
 * npm packages) for the loader to import. Discovery is silent on a
 * missing project directory or absent subdirs — callers that care
 * about "did we find anything?" should check the returned length.
 *
 * @param domain      'fit' / 'sim' / 'asm' / 'lang'.
 * @param projectDir  Project root. Required — there is no user-global
 *                    fallback. Pass undefined to discover nothing
 *                    (used by callers that don't have a project
 *                    context yet).
 */
export function discoverPlugins(
  domain: PluginDomain,
  projectDir?: string,
): DiscoveredPlugin[] {
  if (!projectDir) return []

  const subdirs = USER_SUBDIRS[domain]
  if (!subdirs) {
    // 'lang' / 'asm' — no user-source layout. Return empty; caller
    // (e.g. CLI bootstrap) registers language adapters via direct
    // package imports, not the file-plugin path.
    return []
  }

  const projectPaths = resolveProjectPaths(projectDir)
  const plugins: DiscoveredPlugin[] = []

  // 1. User-source loose files: opensip-tools/<tool>/<kind>/*.{js,mjs}
  const toolDir = join(projectPaths.userSourceDir, domain)
  for (const kind of subdirs) {
    const kindDir = join(toolDir, kind)
    if (!existsSync(kindDir)) continue
    plugins.push(...discoverLooseFiles(kindDir, `${domain}/${kind}`))
  }

  // 2. Npm-installed plugins under .runtime/plugins/<domain>/.
  //    Only walked when the config explicitly declares
  //    plugins.<domain>: [...]. The runtime dir is gitignored, so
  //    silently auto-loading anything in it would be a recipe for
  //    "where did this check come from?" surprises. Explicit listing
  //    is the contract for npm plugins.
  const declared = readProjectPluginsList(projectDir, domain)
  if (declared && declared.length > 0) {
    const pluginsDir = projectPaths.pluginsDir(domain as 'fit' | 'sim')
    const nodeModulesDir = join(pluginsDir, 'node_modules')
    if (existsSync(nodeModulesDir)) {
      plugins.push(...discoverNpmPackages(nodeModulesDir, pluginsDir, declared))
    }
  }

  logger.info({
    evt: 'plugin.loader.discover',
    module: MODULE_TAG,
    domain,
    packageCount: plugins.filter(p => p.type === 'package').length,
    fileCount: plugins.filter(p => p.type === 'file').length,
  })

  return plugins
}

// =============================================================================
// CONFIG READING (plugins.<domain> from opensip-tools.config.yml)
// =============================================================================

/**
 * Read the declared plugin list for a domain from the project config.
 * Returns undefined when the config is absent, unreadable, or has no
 * entry for the domain. Does NOT throw on YAML parse errors — returns
 * undefined so discovery falls through gracefully and the config-layer
 * schema validation surfaces parse errors on its own path.
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
    const raw = readFileSync(configPath, 'utf8')
    const yaml = requireFromHere('js-yaml') as { load: (s: string) => unknown }
    const doc = yaml.load(raw) as Record<string, unknown> | null
    if (!doc || typeof doc !== 'object') return undefined
    const plugins = doc.plugins
    if (!plugins || typeof plugins !== 'object') return undefined
    const list = (plugins as Record<string, unknown>)[domain]
    if (!Array.isArray(list)) return undefined
    return list.filter((v): v is string => typeof v === 'string')
  } catch {
    return undefined
  }
}

// =============================================================================
// NPM PACKAGE DISCOVERY
// =============================================================================

function discoverNpmPackages(
  nodeModulesDir: string,
  pluginDir: string,
  declared: readonly string[],
): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = []

  for (const name of declared) {
    // Reject names that could traverse before they ever touch the filesystem.
    // The plugin list comes from opensip-tools.config.yml — user-controlled
    // content under a project that runs `opensip-tools fit` would otherwise
    // act as an attacker-influenced input flowing into a path join.
    if (name.length === 0 || name.includes('..') || name.startsWith('/') || name.includes('\0')) {
      logger.warn({
        evt: 'plugin.loader.discover.reject',
        module: MODULE_TAG,
        reason: 'invalid plugin name',
        name,
      })
      continue
    }
    const packageDir = join(nodeModulesDir, name)
    // Containment check: the resolved real path (after symlinks) must
    // stay inside node_modules. Catches symlink-based escapes if an
    // attacker plants a symlink.
    if (!isPathInside(packageDir, nodeModulesDir)) {
      logger.warn({
        evt: 'plugin.loader.discover.reject',
        module: MODULE_TAG,
        reason: 'package path resolves outside node_modules',
        name,
      })
      continue
    }
    const plugin = tryDiscoverPackage(packageDir, name)
    if (plugin) plugins.push(plugin)
  }

  // pluginDir reference kept for parity with prior log shape
  void pluginDir

  return plugins
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- entry point resolution: walks exports map (string vs object vs nested condition) + main + default; each branch documents a real npm shape
function tryDiscoverPackage(packageDir: string, name: string): DiscoveredPlugin | undefined {
  if (!safeIsDirectory(packageDir)) return undefined

  const pkgJsonPath = join(packageDir, 'package.json')
  if (!existsSync(pkgJsonPath)) return undefined

  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>
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
    entryPoint ??= join(packageDir, 'index.js')

    if (!existsSync(entryPoint)) {
      logger.debug({
        evt: 'plugin.loader.discover.skip',
        module: MODULE_TAG,
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
      module: MODULE_TAG,
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

function discoverLooseFiles(dir: string, namespacePrefix: string): DiscoveredPlugin[] {
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

    // Containment check: a symlink in the plugin dir pointing outside
    // it would otherwise be dynamically imported, executing arbitrary
    // code from wherever the symlink leads. statSync follows symlinks
    // (intentionally — pnpm uses symlinks inside node_modules for
    // legitimate reasons), so we verify the real path stays inside
    // the plugin dir.
    if (!isPathInside(fullPath, dir)) {
      logger.warn({
        evt: 'plugin.loader.discover.reject',
        module: MODULE_TAG,
        reason: 'loose file resolves outside plugin dir',
        entry,
      })
      continue
    }

    const baseName = basename(entry, ext)

    plugins.push({
      type: 'file',
      entryPoint: fullPath,
      namespace: `${namespacePrefix}/${baseName}`,
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
 * Returns true iff `child`, after resolving symlinks, is the same path
 * as `parent` or located inside it. Used as a security boundary check
 * against attacker-influenced paths in plugin discovery.
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
