// @fitness-ignore-file toctou-race-condition -- cache check + populate is synchronous (sync file I/O + Map.set); no async gap, safe in single-threaded Node.js
/**
 * @fileoverview Load and cache opensip-tools.config.yml
 *
 * Reads the signalers config file (path resolved via config-resolution),
 * validates with Zod, and returns a frozen SignalersConfig. Throws when
 * the config file is missing — silent no-op would mask a broken scan.
 */

import { readFileSync, statSync } from 'node:fs'

import { PROJECT_CONFIG_FILENAME, resolveProjectConfigPath } from '@opensip-tools/core'
import { ValidationError, SystemError } from '@opensip-tools/core'
import yaml from 'js-yaml'

const deepFreeze = <T>(obj: T): T => JSON.parse(JSON.stringify(obj)) as T
import { logger } from '@opensip-tools/core'

import { SignalersConfigSchema } from './schema.js'
import type { SignalersConfig } from './types.js'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

/** TTL for cached signalers config entries in milliseconds (30 seconds) */
const SIGNALERS_CACHE_TTL_MS = 30_000

interface CacheEntry {
  config: SignalersConfig
  cachedAt: number
  filePath: string
}

/** Cache keyed by resolved absolute file path, not rootDir — avoids
 *  stale hits when the same rootDir resolves to different files over
 *  time (e.g. --config flag changes between invocations in tests). */
const cache = new Map<string, CacheEntry>()

/**
 * Read the raw config file from disk.
 * @throws {SystemError} When the config file exceeds the maximum allowed size
 * @throws {ValidationError} When the config file cannot be read
 */
function readConfigFile(filePath: string): string {
  try {
    const stats = statSync(filePath)
    if (stats.size > MAX_FILE_SIZE) {
      throw new SystemError(
        `Config file too large (${stats.size} bytes, max ${MAX_FILE_SIZE}): ${filePath}`,
        { code: 'SYSTEM.FILE.TOO_LARGE' },
      )
    }
    return readFileSync(filePath, 'utf-8')
  } catch (err) {
    if (err instanceof ValidationError || err instanceof SystemError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new ValidationError(
      `Failed to read config file ${filePath}: ${message}`,
      {
        operation: 'load',
        loader: 'signalers',
        filePath,
        cause: err instanceof Error ? err : undefined,
      },
    )
  }
}

/** @throws {ValidationError} When the YAML content is invalid */
function parseYaml(raw: string, filePath: string): unknown {
  try {
    return yaml.load(raw) ?? {}
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ValidationError(`${filePath} contains invalid YAML: ${message}`, {
      operation: 'load',
      loader: 'signalers',
      cause: err instanceof Error ? err : undefined,
    })
  }
}

/**
 * Load and validate opensip-tools.config.yml from the given root directory.
 *
 * Resolution: --config (explicit) → package.json#opensip-tools.configPath
 * → <rootDir>/opensip-tools.config.yml. See resolveProjectConfigPath().
 *
 * Results are cached per resolved file path.
 *
 * @param rootDir - Absolute path to the project root directory
 * @param explicitPath - Optional config path from --config CLI flag
 * @throws {ValidationError} When no config is found, YAML is invalid, or
 *   schema validation fails. Intentionally loud: a missing config means
 *   the scan would otherwise silently produce zero findings.
 */
export function loadSignalersConfig(
  rootDir: string,
  explicitPath?: string,
): SignalersConfig {
  const filePath = resolveProjectConfigPath(rootDir, explicitPath)

  const cached = cache.get(filePath)
  if (cached && (Date.now() - cached.cachedAt) < SIGNALERS_CACHE_TTL_MS) {
    return cached.config
  }

  const raw = readConfigFile(filePath)
  const parsed = parseYaml(raw, filePath)

  const result = SignalersConfigSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message} (expected: ${i.code})`)
      .join('\n')
    throw new ValidationError(
      `${filePath} validation failed:\n${issues}`,
      {
        operation: 'load',
        loader: 'signalers',
        filePath,
        code: 'ERRORS.SIGNALERS.VALIDATION_FAILED',
      },
    )
  }

  const data = result.data
  const targetCount = Object.keys(data.targets).length

  logger.info({
    evt: 'core.signalers.config.loaded',
    module: 'core:signalers',
    file: filePath,
    hasFitness: data.fitness !== undefined,
    hasSimulation: data.simulation !== undefined,
    targetCount,
  })

  const frozen = deepFreeze(data as unknown as Record<string, unknown>) as unknown as SignalersConfig
  cache.set(filePath, { config: frozen, cachedAt: Date.now(), filePath })
  return frozen
}

/**
 * Clear the cached signalers config. Useful for testing.
 */
export function resetSignalersConfigCache(): void {
  cache.clear()
}

/** Re-export so tests and the init command can reference the canonical filename. */
export { PROJECT_CONFIG_FILENAME }
