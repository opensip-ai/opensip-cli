/**
 * @fileoverview Explicit check-package resolution for `plugins.checkPackages`.
 *
 * Automatic check-pack discovery is marker-based (`opensipTools.kind:
 * "fit-pack"`) and lives in core's marker walker, called by `check-loader.ts`.
 * This module only keeps the exact-name compatibility path: users can list
 * package names in `plugins.checkPackages` when they need to load a pack that
 * does not declare the marker yet, or when they want to name the package
 * explicitly in config.
 */

import { join } from 'node:path'

import {
  logger,
  readYamlFile,
  resolvePackageDir,
  resolvePackageEntryPoint,
} from '@opensip-tools/core'

const CONFIG_FILENAME = 'opensip-tools.config.yml'

export interface CheckPackageDiscoveryOptions {
  /** Absolute path to the project root (where opensip-tools.config.yml lives). */
  readonly projectDir: string
  /** Explicit list from `plugins.checkPackages` in the config. */
  readonly explicitPackages?: readonly string[]
}

export interface DiscoveredCheckPackage {
  /** npm package name, e.g. '@opensip-tools/checks-python'. */
  readonly name: string
  /** Absolute path to the package's directory inside node_modules. */
  readonly packageDir: string
}

/**
 * Resolve the exact package names listed under `plugins.checkPackages`.
 * Marker discovery runs separately in `check-loader.ts`.
 */
export function discoverCheckPackages(
  options: CheckPackageDiscoveryOptions,
): DiscoveredCheckPackage[] {
  const { projectDir, explicitPackages } = options

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
  return []
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
 * Read `plugins.checkPackages` from the project's opensip-tools.config.yml
 * without doing a full schema parse.
 *
 * Mirrors the inline-yaml-read pattern used by readProjectPluginsList()
 * — avoids a circular dep between plugins/ and targets/.
 */
export function readCheckPackagePreferences(projectDir: string): {
  readonly checkPackages?: readonly string[]
} {
  const configPath = join(projectDir, CONFIG_FILENAME)
  const doc = readYamlFile(configPath)
  if (!doc || typeof doc !== 'object') return {}
  const plugins = (doc as Record<string, unknown>).plugins
  if (!plugins || typeof plugins !== 'object') return {}
  const p = plugins as Record<string, unknown>
  const result: {
    checkPackages?: readonly string[]
  } = {}
  if (Array.isArray(p.checkPackages)) {
    result.checkPackages = p.checkPackages.filter((v): v is string => typeof v === 'string')
  }
  return result
}

export function readCheckPackageMetadata(packageDir: string): CheckPackageMetadata | undefined {
  const resolved = resolvePackageEntryPoint(packageDir)
  if (!resolved) return undefined
  return { name: resolved.name, mainEntry: resolved.entry }
}
