// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Target config loader
 *
 * Loads target configuration from opensip-tools.config.yml in the project root.
 * Validates with Zod and populates a TargetRegistry.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { ValidationError, SystemError } from '../lib/errors.js'
import yaml from 'js-yaml'
import { z } from 'zod'


import { TargetRegistry } from './target-registry.js'
import type { CheckTargetMap, TargetConfig, TargetsConfig } from './types.js'

const YAML_FILENAME = 'opensip-tools.config.yml'
const DEFAULT_EXCLUDES: readonly string[] = ['**/node_modules/**', '**/dist/**']

// =============================================================================
// YAML schemas
// =============================================================================

const TargetEntrySchema = z.object({
  description: z.string().min(1, 'description is required'),
  include: z.array(z.string()).min(1, 'at least one include pattern is required'),
  exclude: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  concerns: z.array(z.string()).optional(),
})

const CheckTargetValueSchema = z.union([
  z.string(),
  z.array(z.string()).min(1),
])

const PluginsSchema = z.object({
  fit: z.array(z.string()).optional(),
  sim: z.array(z.string()).optional(),
  asm: z.array(z.string()).optional(),
}).optional()

const TargetsFileSchema = z.object({
  targets: z.record(
    z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'target name must be kebab-case'),
    TargetEntrySchema,
  ),
  globalExcludes: z.array(z.string()).optional(),
  checkOverrides: z.record(z.string(), CheckTargetValueSchema).optional(),
  plugins: PluginsSchema,
})

// =============================================================================
// Build registry + config from parsed data
// =============================================================================

/** @throws {ValidationError} When checkOverrides references an unknown target */
// eslint-disable-next-line sonarjs/cognitive-complexity -- inherent complexity: registry population + cross-validation
function buildFromParsed(
  targets: Record<string, { description: string; include: readonly string[]; exclude?: readonly string[]; tags?: readonly string[]; languages?: readonly string[]; concerns?: readonly string[] }>,
  rawGlobalExcludes: readonly string[] | undefined,
  rawCheckOverrides: Record<string, string | readonly string[]> | undefined,
  sourceLabel: string,
  rawPlugins?: { fit?: readonly string[]; sim?: readonly string[]; asm?: readonly string[] },
): { registry: TargetRegistry; config: TargetsConfig } {
  const registry = new TargetRegistry()

  for (const [name, entry] of Object.entries(targets)) {
    const config: TargetConfig = Object.freeze({
      name,
      description: entry.description,
      include: Object.freeze([...entry.include]),
      exclude: Object.freeze([...(entry.exclude ?? DEFAULT_EXCLUDES)]),
      ...(entry.tags && { tags: Object.freeze([...entry.tags]) }),
      ...(entry.languages && { languages: Object.freeze([...entry.languages]) }),
      ...(entry.concerns && { concerns: Object.freeze([...entry.concerns]) }),
    })
    registry.register(Object.freeze({ config }))
  }

  const checkOverrides: Record<string, string | readonly string[]> = {}
  if (rawCheckOverrides) {
    for (const [checkSlug, targetRef] of Object.entries(rawCheckOverrides)) {
      const targetNames = Array.isArray(targetRef) ? targetRef : [targetRef]
      for (const name of targetNames) {
        if (!registry.has(name)) {
          // @fitness-ignore-next-line result-pattern-consistency -- infrastructure boundary, throw is appropriate
          throw new ValidationError(
            `${sourceLabel}: checkOverrides['${checkSlug}'] references unknown target '${name}'. ` +
            `Available targets: ${registry.getAll().map((t) => t.config.name).join(', ')}`,
            { code: 'ERRORS.TARGETS.UNKNOWN_TARGET' },
          )
        }
      }
      checkOverrides[checkSlug] = Array.isArray(targetRef) ? Object.freeze([...targetRef]) : targetRef
    }
  }

  const plugins = rawPlugins
    ? Object.freeze({
        ...(rawPlugins.fit && { fit: Object.freeze([...rawPlugins.fit]) as readonly string[] }),
        ...(rawPlugins.sim && { sim: Object.freeze([...rawPlugins.sim]) as readonly string[] }),
        ...(rawPlugins.asm && { asm: Object.freeze([...rawPlugins.asm]) as readonly string[] }),
      })
    : undefined

  const config: TargetsConfig = Object.freeze({
    globalExcludes: Object.freeze(rawGlobalExcludes ? [...rawGlobalExcludes] : []) as readonly string[],
    checkOverrides: Object.freeze(checkOverrides) as CheckTargetMap,
    ...(plugins && { plugins }),
  })

  return { registry, config }
}

// =============================================================================
// YAML config loader
// =============================================================================

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

/** @throws {ValidationError} When the file is too large, missing, or unreadable */
function readYamlFile(filePath: string): string {
  try {
    const stats = statSync(filePath)
    if (stats.size > MAX_FILE_SIZE) {
      throw new SystemError(`File too large (${stats.size} bytes, max ${MAX_FILE_SIZE}): ${filePath}`, { code: 'SYSTEM.FILE.TOO_LARGE' })
    }
    return readFileSync(filePath, 'utf-8')
  } catch (err) {
    if (err instanceof ValidationError || err instanceof SystemError) throw err
    throw new ValidationError(
      `${YAML_FILENAME} not found at ${filePath}. Create one to define your targets.`,
      { operation: 'load', loader: 'targets' },
    )
  }
}

/** @throws {ValidationError} When the YAML is malformed */
function parseYamlContent(raw: string): unknown {
  try {
    return yaml.load(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ValidationError(`${YAML_FILENAME} contains invalid YAML: ${message}`, {
      operation: 'load',
      loader: 'targets',
      cause: err instanceof Error ? err : undefined,
    })
  }
}

/**
 * @throws {ValidationError} When the file is missing or contains invalid YAML
 * @throws {ValidationError} When the file fails schema validation
 */
function loadYamlConfig(filePath: string): { registry: TargetRegistry; config: TargetsConfig } {
  const raw = readYamlFile(filePath)
  const parsed = parseYamlContent(raw)

  const result = TargetsFileSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    // @fitness-ignore-next-line result-pattern-consistency -- infrastructure boundary, throw is appropriate
    throw new ValidationError(`${YAML_FILENAME} validation failed:\n${issues}`, {
      code: 'ERRORS.TARGETS.VALIDATION_FAILED',
    })
  }

  return buildFromParsed(
    result.data.targets,
    result.data.globalExcludes,
    result.data.checkOverrides,
    YAML_FILENAME,
    result.data.plugins,
  )
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Load targets from opensip-tools.config.yml in the given root directory.
 * @throws {ValidationError} When the config file is missing, too large, or contains invalid YAML
 * @throws {ValidationError} When the config file fails schema validation
 */
export function loadTargets(rootDir: string): TargetRegistry {
  const yamlPath = join(rootDir, YAML_FILENAME)
  // @fitness-ignore-next-line null-safety -- loadYamlConfig always returns a valid {registry, config} object or throws
  return loadYamlConfig(yamlPath).registry
}

/**
 * Load full targets config including per-check target overrides.
 * @throws {ValidationError} When no targets config file is found or it cannot be loaded
 * @throws {ValidationError} When the config file fails schema validation
 */
export function loadTargetsConfig(
  rootDir: string,
): { registry: TargetRegistry; config: TargetsConfig } {
  const yamlPath = join(rootDir, YAML_FILENAME)
  if (!existsSync(yamlPath)) {
    throw new ValidationError(
      `No targets config found. Create ${YAML_FILENAME} in ${rootDir}.`,
      { operation: 'load', loader: 'targets' },
    )
  }
  return loadYamlConfig(yamlPath)
}
