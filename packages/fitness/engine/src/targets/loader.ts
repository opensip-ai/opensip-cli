// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Target config loader
 *
 * Loads target configuration from opensip-tools.config.yml in the project root.
 * Validates with Zod and populates a TargetRegistry.
 */

import {
  checkOverridesSchema,
  globalExcludesSchema,
  targetsRecordSchema,
} from '@opensip-tools/config';
import {
  PROJECT_CONFIG_FILENAME,
  ValidationError,
  readYamlFileOrThrow,
  resolveProjectConfigPath,
} from '@opensip-tools/core';
import { z } from 'zod';

import { TargetRegistry } from './target-registry.js';

import type { TargetConfig, TargetsConfig } from './types.js';

const YAML_FILENAME = PROJECT_CONFIG_FILENAME;
const DEFAULT_EXCLUDES: readonly string[] = ['**/node_modules/**', '**/dist/**'];

// =============================================================================
// YAML schemas
// =============================================================================

// The targets / globalExcludes / checkOverrides shapes are owned by
// @opensip-tools/config (2.10.1, ADR-0023) — the same schemas the host
// registers as document-level declarations. This loader composes them with the
// fitness-local `plugins` block (a discovery concern, out of the targeting
// migration) and adds the registry build + cross-validation runtime below.
const PluginsSchema = z
  .object({
    fit: z.array(z.string()).optional(),
    sim: z.array(z.string()).optional(),
    lang: z.array(z.string()).optional(),
    checkPackages: z.array(z.string()).optional(),
    packageScopes: z.array(z.string()).optional(),
  })
  .optional();

const TargetsFileSchema = z.object({
  targets: targetsRecordSchema,
  globalExcludes: globalExcludesSchema.optional(),
  checkOverrides: checkOverridesSchema.optional(),
  plugins: PluginsSchema,
});

// =============================================================================
// Build registry + config from parsed data
// =============================================================================

/** @throws {ValidationError} When checkOverrides references an unknown target */
// eslint-disable-next-line sonarjs/cognitive-complexity -- inherent complexity: registry population + cross-validation
function buildFromParsed(
  targets: Record<
    string,
    {
      description: string;
      include: readonly string[];
      exclude?: readonly string[];
      tags?: readonly string[];
      languages?: readonly string[];
      concerns?: readonly string[];
    }
  >,
  rawGlobalExcludes: readonly string[] | undefined,
  rawCheckOverrides: Record<string, string | readonly string[]> | undefined,
  sourceLabel: string,
  rawPlugins?: {
    fit?: readonly string[];
    sim?: readonly string[];
    lang?: readonly string[];
    checkPackages?: readonly string[];
    packageScopes?: readonly string[];
  },
): { registry: TargetRegistry; config: TargetsConfig } {
  const registry = new TargetRegistry();

  for (const [name, entry] of Object.entries(targets)) {
    const config: TargetConfig = Object.freeze({
      name,
      description: entry.description,
      include: Object.freeze([...entry.include]),
      exclude: Object.freeze([...(entry.exclude ?? DEFAULT_EXCLUDES)]),
      ...(entry.tags && { tags: Object.freeze([...entry.tags]) }),
      ...(entry.languages && { languages: Object.freeze([...entry.languages]) }),
      ...(entry.concerns && { concerns: Object.freeze([...entry.concerns]) }),
    });
    registry.register(Object.freeze({ config }));
  }

  const checkOverrides: Record<string, string | readonly string[]> = {};
  if (rawCheckOverrides) {
    for (const [checkSlug, targetRef] of Object.entries(rawCheckOverrides)) {
      const targetNames = typeof targetRef === 'string' ? [targetRef] : targetRef;
      for (const name of targetNames) {
        if (!registry.has(name)) {
          // @fitness-ignore-next-line result-pattern-consistency -- infrastructure boundary, throw is appropriate
          throw new ValidationError(
            `${sourceLabel}: checkOverrides['${checkSlug}'] references unknown target '${name}'. ` +
              `Available targets: ${registry
                .getAll()
                .map((t) => t.config.name)
                .join(', ')}`,
            { code: 'ERRORS.TARGETS.UNKNOWN_TARGET' },
          );
        }
      }
      checkOverrides[checkSlug] =
        typeof targetRef === 'string' ? targetRef : Object.freeze([...targetRef]);
    }
  }

  const plugins = rawPlugins
    ? Object.freeze({
        ...(rawPlugins.fit && { fit: Object.freeze([...rawPlugins.fit]) }),
        ...(rawPlugins.sim && { sim: Object.freeze([...rawPlugins.sim]) }),
        ...(rawPlugins.lang && { lang: Object.freeze([...rawPlugins.lang]) }),
        ...(rawPlugins.checkPackages && {
          checkPackages: Object.freeze([...rawPlugins.checkPackages]),
        }),
        ...(rawPlugins.packageScopes && {
          packageScopes: Object.freeze([...rawPlugins.packageScopes]),
        }),
      })
    : undefined;

  const config: TargetsConfig = Object.freeze({
    globalExcludes: Object.freeze(rawGlobalExcludes ? [...rawGlobalExcludes] : []),
    checkOverrides: Object.freeze(checkOverrides),
    ...(plugins && { plugins }),
  });

  return { registry, config };
}

// =============================================================================
// YAML config loader
// =============================================================================

/**
 * @throws {SystemError} When the file exceeds the shared default 10 MB cap.
 * @throws {ValidationError} When the file is missing, unreadable, contains
 *   invalid YAML, or fails schema validation.
 */
function loadYamlConfig(filePath: string): { registry: TargetRegistry; config: TargetsConfig } {
  // Strict YAML read + parse via the shared core helper (audit-round-3
  // Finding G — completes the round-2 migration that signalers/loader
  // already adopted). Raises `SystemError` for oversized files and
  // `ValidationError` for missing / unreadable / malformed YAML.
  const parsed = readYamlFileOrThrow(filePath, { loader: 'targets' });

  const result = TargetsFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    // @fitness-ignore-next-line result-pattern-consistency -- infrastructure boundary, throw is appropriate
    throw new ValidationError(`${YAML_FILENAME} validation failed:\n${issues}`, {
      code: 'ERRORS.TARGETS.VALIDATION_FAILED',
    });
  }

  return buildFromParsed(
    result.data.targets,
    result.data.globalExcludes,
    result.data.checkOverrides,
    YAML_FILENAME,
    result.data.plugins,
  );
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
  const yamlPath = resolveProjectConfigPath(rootDir, explicitPath);
  return loadYamlConfig(yamlPath);
}
