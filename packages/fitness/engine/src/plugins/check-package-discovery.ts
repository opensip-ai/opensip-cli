/**
 * @fileoverview The `plugins.checkPackages` preference reader.
 *
 * Check-pack discovery + resolution (marker walk, the `@opensip-tools` built-in
 * split, explicit-name resolution, the single-core guard) lives in the GENERIC
 * capability substrate (`@opensip-tools/core`) now. This module keeps only the
 * fitness-side reader for the documented `plugins.checkPackages` config key —
 * fitness resolves its own preference without depending on `@opensip-tools/config`,
 * then hands an explicit-package list to the generic loader.
 */

import { join } from 'node:path'

import { readYamlFile } from '@opensip-tools/core'

const CONFIG_FILENAME = 'opensip-tools.config.yml'

/**
 * Read `plugins.checkPackages` from the project's opensip-tools.config.yml
 * without a full schema parse. Mirrors the inline-yaml-read pattern used by
 * `readProjectPluginsList()` — avoids a circular dep between plugins/ and targets/.
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
  const result: { checkPackages?: readonly string[] } = {}
  if (Array.isArray(p.checkPackages)) {
    result.checkPackages = p.checkPackages.filter((v): v is string => typeof v === 'string')
  }
  return result
}
