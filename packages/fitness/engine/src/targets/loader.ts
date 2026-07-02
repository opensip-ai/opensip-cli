/**
 * @fileoverview Target config loader
 *
 * Loads target configuration from opensip-cli.config.yml in the project root.
 * Validates with Zod and populates a TargetRegistry.
 */

import {
  checkOverridesSchema,
  findUnsafeTargetConventionPaths,
  freezeTargetConventions,
  globalExcludesSchema,
  pluginsConfigSchema,
  targetsRecordSchema,
} from '@opensip-cli/config';
import {
  PROJECT_CONFIG_FILENAME,
  ValidationError,
  currentScope,
  readYamlFileOrThrow,
  resolveProjectConfigPath,
} from '@opensip-cli/core';
import { z } from 'zod';

import { TargetRegistry } from './target-registry.js';

import type {
  PluginsConfig,
  TargetConfig,
  TargetConventionsConfig,
  TargetsConfig,
} from './types.js';

const YAML_FILENAME = PROJECT_CONFIG_FILENAME;
const DEFAULT_EXCLUDES: readonly string[] = ['**/node_modules/**', '**/dist/**'];

// =============================================================================
// YAML schemas
// =============================================================================

// The targets / globalExcludes / checkOverrides / plugins shapes are owned by
// @opensip-cli/config (2.10.1, ADR-0023) — the same schemas the host
// registers as document-level declarations. This loader adds the registry build
// + cross-validation runtime below.
const TargetsFileSchema = z.object({
  targets: targetsRecordSchema,
  globalExcludes: globalExcludesSchema.optional(),
  checkOverrides: checkOverridesSchema.optional(),
  plugins: pluginsConfigSchema.optional(),
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
      conventions?: TargetConventionsConfig;
    }
  >,
  rawGlobalExcludes: readonly string[] | undefined,
  rawCheckOverrides: Record<string, string | readonly string[]> | undefined,
  sourceLabel: string,
  rawPlugins?: PluginsConfig,
): { registry: TargetRegistry; config: TargetsConfig } {
  const registry = new TargetRegistry();
  rejectUnsafeConventionPathsInFitnessConfig(targets, sourceLabel);

  // ADR-0037 cutover: the host already parsed `targets:` from the single
  // validated config document into `scope.targets` (Phase 1). When that host
  // set is present, fitness CONSUMES it — mirroring the same frozen `Target`
  // references into a fitness registry so the check-domain `findByScope` can run
  // over them — rather than re-deriving its own generic target set. The fitness
  // `toTarget` normalization (build-targets.ts) is byte-identical to the
  // fallback below, so this is a reference copy, not a re-parse.
  const scopeTargets = currentScope()?.targets;
  if (scopeTargets) {
    for (const target of scopeTargets.getAll()) {
      registry.register(target);
    }
  } else {
    // Fallback: no host `scope.targets` (a config-less/agnostic run, or a unit
    // test that doesn't wire a scope) — build the registry from the parsed
    // `targets:` block directly. Same normalization the host applies.
    for (const [name, entry] of Object.entries(targets)) {
      const config: TargetConfig = Object.freeze({
        name,
        description: entry.description,
        include: Object.freeze([...entry.include]),
        exclude: Object.freeze([...(entry.exclude ?? DEFAULT_EXCLUDES)]),
        ...(entry.tags && { tags: Object.freeze([...entry.tags]) }),
        ...(entry.languages && {
          languages: Object.freeze([...entry.languages]),
        }),
        ...(entry.concerns && { concerns: Object.freeze([...entry.concerns]) }),
        ...(entry.conventions && { conventions: freezeTargetConventions(entry.conventions) }),
      });
      registry.register(Object.freeze({ config }));
    }
  }

  // checkOverrides is fitness-namespaced config the host does NOT semantically
  // cross-validate (only fitness knows check slugs). Each referenced target name
  // is validated against `registry` — which now mirrors `scope.targets` (the
  // host-owned set) when present, exactly the cross-reference ADR-0037 requires.
  const checkOverrides: Record<string, string | readonly string[]> = {};
  if (rawCheckOverrides) {
    for (const [checkSlug, targetRef] of Object.entries(rawCheckOverrides)) {
      const targetNames = typeof targetRef === 'string' ? [targetRef] : targetRef;
      for (const name of targetNames) {
        if (!registry.has(name)) {
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
    ? Object.freeze(
        Object.fromEntries(
          Object.entries(rawPlugins).flatMap(([key, value]) => {
            if (value === undefined) return [];
            return [[key, typeof value === 'boolean' ? value : Object.freeze([...value])] as const];
          }),
        ) as PluginsConfig,
      )
    : undefined;

  const config: TargetsConfig = Object.freeze({
    globalExcludes: Object.freeze(rawGlobalExcludes ? [...rawGlobalExcludes] : []),
    checkOverrides: Object.freeze(checkOverrides),
    ...(plugins && { plugins }),
  });

  return { registry, config };
}

function rejectUnsafeConventionPathsInFitnessConfig(
  targets: Record<string, { conventions?: TargetConventionsConfig }>,
  sourceLabel: string,
): void {
  for (const [targetName, entry] of Object.entries(targets)) {
    for (const issue of findUnsafeTargetConventionPaths(entry.conventions)) {
      throw new ValidationError(
        `${sourceLabel}: targets.${targetName}.conventions.${issue.field} contains unsafe glob ` +
          `'${issue.pattern}'. Convention paths must be project-relative and must not contain ` +
          `'..' path segments.`,
        { code: 'ERRORS.TARGETS.VALIDATION_FAILED' },
      );
    }
  }
}

// =============================================================================
// YAML config loader
// =============================================================================

/**
 * Validate an already-parsed config document and build the fitness target
 * registry + config from it. Shared by the scope-first and file-read paths —
 * the fitness-specific projection (targets shape) and cross-validation
 * (`checkOverrides` ↔ registry) live here exactly once.
 *
 * @throws {ValidationError} When the document fails schema validation or
 *   `checkOverrides` references an unknown target.
 */
function projectTargetsConfig(
  parsed: unknown,
  sourceLabel: string,
): { registry: TargetRegistry; config: TargetsConfig } {
  const result = TargetsFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ValidationError(`${sourceLabel} validation failed:\n${issues}`, {
      code: 'ERRORS.TARGETS.VALIDATION_FAILED',
    });
  }

  return buildFromParsed(
    result.data.targets,
    result.data.globalExcludes,
    result.data.checkOverrides,
    sourceLabel,
    result.data.plugins as PluginsConfig | undefined,
  );
}

/**
 * @throws {SystemError} When the file exceeds the shared default 10 MB cap.
 * @throws {ValidationError} When the file is missing, unreadable, contains
 *   invalid YAML, or fails schema validation.
 */
function loadYamlConfig(filePath: string): {
  registry: TargetRegistry;
  config: TargetsConfig;
} {
  // Strict YAML read + parse via the shared core helper (audit-round-3
  // Finding G — completes the round-2 migration that signalers/loader
  // already adopted). Raises `SystemError` for oversized files and
  // `ValidationError` for missing / unreadable / malformed YAML.
  const parsed = readYamlFileOrThrow(filePath, { loader: 'targets' });
  return projectTargetsConfig(parsed, YAML_FILENAME);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Load full targets config including per-check target overrides.
 *
 * SCOPE-FIRST (ADR-0023 one-reader): when the current `RunScope` carries the
 * host-validated config document (`scope.configDocument`), the fitness shapes
 * are projected from THAT document — no second file read. The registry build
 * inside `buildFromParsed` additionally mirrors `scope.targets` (ADR-0037)
 * when the host built it. The file read below serves scope-less callers only
 * (programmatic use, unit tests); it resolves via the shared project-config
 * resolver.
 *
 * @throws {ValidationError} When no targets config file is found or it cannot be loaded
 * @throws {ValidationError} When the config file fails schema validation
 */
export function loadTargetsConfig(
  rootDir: string,
  explicitPath?: string,
): { registry: TargetRegistry; config: TargetsConfig } {
  const scope = currentScope();
  const scopeDocument = scope?.configDocument;
  if (scopeDocument !== undefined) {
    return projectTargetsConfig(scopeDocument, YAML_FILENAME);
  }
  if (scope !== undefined) {
    throw new ValidationError(
      `${YAML_FILENAME}: current RunScope has no validated configDocument; ` +
        'refusing a second config-file read from a scoped targets load.',
      { code: 'ERRORS.TARGETS.SCOPE_CONFIG_MISSING' },
    );
  }
  const yamlPath = resolveProjectConfigPath(rootDir, explicitPath);
  return loadYamlConfig(yamlPath);
}
