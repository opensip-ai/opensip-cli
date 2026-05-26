// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Target config loader
 *
 * Loads target configuration from opensip-tools.config.yml in the project root.
 * Validates with Zod and populates a TargetRegistry.
 */

import { readFileSync, statSync } from 'node:fs'

import { PROJECT_CONFIG_FILENAME, resolveProjectConfigPath , ValidationError, SystemError } from '@opensip-tools/core'
import yaml from 'js-yaml'
import { z } from 'zod'


import { TargetRegistry } from './target-registry.js'

import type { TargetConfig, TargetsConfig } from './types.js'

const YAML_FILENAME = PROJECT_CONFIG_FILENAME
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
  lang: z.array(z.string()).optional(),
  checkPackages: z.array(z.string()).optional(),
  autoDiscoverChecks: z.boolean().optional(),
  packageScopes: z.array(z.string()).optional(),
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
  rawPlugins?: {
    fit?: readonly string[]
    sim?: readonly string[]
    asm?: readonly string[]
    lang?: readonly string[]
    checkPackages?: readonly string[]
    autoDiscoverChecks?: boolean
    packageScopes?: readonly string[]
  },
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
      const targetNames = typeof targetRef === 'string' ? [targetRef] : targetRef
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
      checkOverrides[checkSlug] = typeof targetRef === 'string' ? targetRef : Object.freeze([...targetRef])
    }
  }

  const plugins = rawPlugins
    ? Object.freeze({
        ...(rawPlugins.fit && { fit: Object.freeze([...rawPlugins.fit]) }),
        ...(rawPlugins.sim && { sim: Object.freeze([...rawPlugins.sim]) }),
        ...(rawPlugins.asm && { asm: Object.freeze([...rawPlugins.asm]) }),
        ...(rawPlugins.lang && { lang: Object.freeze([...rawPlugins.lang]) }),
        ...(rawPlugins.checkPackages && { checkPackages: Object.freeze([...rawPlugins.checkPackages]) }),
        ...(rawPlugins.autoDiscoverChecks !== undefined && { autoDiscoverChecks: rawPlugins.autoDiscoverChecks }),
        ...(rawPlugins.packageScopes && { packageScopes: Object.freeze([...rawPlugins.packageScopes]) }),
      })
    : undefined

  const config: TargetsConfig = Object.freeze({
    globalExcludes: Object.freeze(rawGlobalExcludes ? [...rawGlobalExcludes] : []),
    checkOverrides: Object.freeze(checkOverrides),
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
    return readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error instanceof ValidationError || error instanceof SystemError) throw error
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ValidationError(`${YAML_FILENAME} contains invalid YAML: ${message}`, {
      operation: 'load',
      loader: 'targets',
      cause: error instanceof Error ? error : undefined,
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
 * Load full targets config including per-check target overrides.
 * Resolves via the shared project-config resolver.
 * @throws {ValidationError} When no targets config file is found or it cannot be loaded
 * @throws {ValidationError} When the config file fails schema validation
 */
export function loadTargetsConfig(
  rootDir: string,
  explicitPath?: string,
): { registry: TargetRegistry; config: TargetsConfig } {
  const yamlPath = resolveProjectConfigPath(rootDir, explicitPath)
  return loadYamlConfig(yamlPath)
}
