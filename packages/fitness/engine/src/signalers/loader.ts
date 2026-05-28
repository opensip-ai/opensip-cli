// @fitness-ignore-file toctou-race-condition -- cache check + populate is synchronous (sync file I/O + Map.set); no async gap, safe in single-threaded Node.js
// @fitness-ignore-file batch-operation-limits -- iterates bounded collection (signaler entries listed in opensip-tools.config.yml)
/**
 * @fileoverview Load and cache opensip-tools.config.yml
 *
 * Reads the signalers config file (path resolved via config-resolution),
 * validates with Zod, and returns a frozen SignalersConfig. Throws when
 * the config file is missing — silent no-op would mask a broken scan.
 */

import { ValidationError, readYamlFileOrThrow, resolveProjectConfigPath, logger } from '@opensip-tools/core'

import { SignalersConfigSchema } from './schema.js'

import type { SignalersConfig } from './types.js'

/**
 * Recursively freeze every nested object so the `DeepReadonly` claim
 * on `SignalersConfig` is honoured at runtime, not just at the type
 * level. The previous implementation aliased `structuredClone` under
 * the name `deepFreeze` — it copied without freezing, so the
 * `SignalersConfig` readonly type was a lie at runtime. Audit-round-2
 * Finding E.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

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

  // Strict YAML read + parse via the shared core helper (audit-round-2
  // Finding F). Raises `SystemError` if the file is larger than the
  // default 10 MB cap, `ValidationError` for missing / unreadable /
  // malformed YAML — same shape this loader used to throw inline.
  const parsed = readYamlFileOrThrow(filePath, { loader: 'signalers' })

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

  // `data` is typed `z.infer<typeof SignalersConfigSchema>` (mutable).
  // After deepFreeze it's structurally read-only end-to-end; the single
  // cast adds the `DeepReadonly` wrapper that defines `SignalersConfig`.
  const frozen = deepFreeze(data) as SignalersConfig
  cache.set(filePath, { config: frozen, cachedAt: Date.now(), filePath })
  return frozen
}

