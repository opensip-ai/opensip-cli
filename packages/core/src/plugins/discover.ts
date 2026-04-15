/**
 * @fileoverview Plugin discovery for ~/.opensip-tools/{fit,sim,asm}/
 *
 * Scans for npm packages in node_modules/ and loose .js/.mjs files.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { homedir } from 'node:os'

import { logger } from '../lib/logger.js'

import type { DiscoveredPlugin, PluginDomain } from './types.js'

const DEFAULT_BASE_DIR = join(homedir(), '.opensip-tools')

/** Get the absolute path to a plugin domain directory. */
export function getPluginDir(domain: PluginDomain, baseDir?: string): string {
  return join(baseDir ?? DEFAULT_BASE_DIR, domain)
}

/** Get the base directory for all plugins. */
export function getBaseDir(baseDir?: string): string {
  return baseDir ?? DEFAULT_BASE_DIR
}

/**
 * Discover all plugins in a domain directory.
 * Returns discovered plugins sorted: packages first, then files.
 */
export function discoverPlugins(
  domain: PluginDomain,
  baseDir?: string,
): DiscoveredPlugin[] {
  const dir = getPluginDir(domain, baseDir)
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
    const packageDir = join(nodeModulesDir, name)
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
