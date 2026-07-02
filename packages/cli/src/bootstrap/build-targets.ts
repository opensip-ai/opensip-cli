/**
 * build-targets — the host's once-per-run construction of `scope.targets`
 * (ADR-0037, generic-targeting-runtime Phase 1).
 *
 * The composition root reads the already-resolved config document, parses the
 * host-owned `targets:` / `globalExcludes:` blocks through the
 * `@opensip-cli/config` Zod field schemas, registers each target into the
 * substrate `TargetRegistry`, and returns a `TargetResolver` — the structural
 * scope-slot shape `core` declares — wrapping the registry plus the bound
 * `resolveTargets` / `applyGlobalExcludes` closures + the project
 * `globalExcludes`. The CLI bootstrap attaches the result as `scope.targets`,
 * mirroring how `composeAndValidateToolConfig` produces `scope.toolConfig`.
 *
 * The host build is the GENERIC half only: it does NOT validate `checkOverrides`
 * (a check-slug concept) — that cross-validation stays in
 * `@opensip-cli/fitness`'s loader (Phase 2). A run with no config document, or
 * a config document with no `targets:` block, yields `undefined` — exactly like
 * a config-less `toolConfig`.
 */

import {
  findUnsafeTargetConventionPaths,
  freezeTargetConventions,
  globalExcludesSchema,
  targetsRecordSchema,
  type Target,
  type TargetConventionsConfig,
} from '@opensip-cli/config';
import { ConfigurationError, isPlainRecord, type TargetResolver } from '@opensip-cli/core';
import { TargetRegistry, applyGlobalExcludes, resolveTargets } from '@opensip-cli/targeting';

/**
 * Default per-target exclusion globs, applied when a target declares no
 * explicit `exclude`. Mirrors the fitness loader's fallback normalization so
 * the host-built set and the scope-less fallback build (fitness
 * `targets/loader.ts`, kept for programmatic/test use) stay byte-identical.
 */
const DEFAULT_EXCLUDES: readonly string[] = ['**/node_modules/**', '**/dist/**'];

/**
 * Normalize one parsed `targets.<name>` entry into the frozen `Target` shape
 * the substrate registry holds — defaulting `exclude` to {@link DEFAULT_EXCLUDES}
 * and freezing every array, matching the fitness loader's `buildFromParsed`.
 */
function toTarget(
  name: string,
  entry: {
    description: string;
    include: readonly string[];
    exclude?: readonly string[];
    tags?: readonly string[];
    languages?: readonly string[];
    concerns?: readonly string[];
    conventions?: TargetConventionsConfig;
  },
): Target {
  const config = Object.freeze({
    name,
    description: entry.description,
    include: Object.freeze([...entry.include]),
    exclude: Object.freeze([...(entry.exclude ?? DEFAULT_EXCLUDES)]),
    ...(entry.tags && { tags: Object.freeze([...entry.tags]) }),
    ...(entry.languages && { languages: Object.freeze([...entry.languages]) }),
    ...(entry.concerns && { concerns: Object.freeze([...entry.concerns]) }),
    ...(entry.conventions && { conventions: freezeTargetConventions(entry.conventions) }),
  });
  return Object.freeze({ config });
}

function validateConventionPath(targetName: string, field: string, pattern: string): void {
  throw new ConfigurationError(
    `Invalid 'targets.${targetName}.conventions.${field}' glob in opensip-cli.config.yml: ` +
      `'${pattern}' must be project-relative and must not contain '..' path segments.`,
    { code: 'CONFIGURATION.TARGETS.INVALID' },
  );
}

function rejectUnsafeConventionPathsForTarget(
  targetName: string,
  conventions: TargetConventionsConfig | undefined,
): void {
  for (const issue of findUnsafeTargetConventionPaths(conventions)) {
    validateConventionPath(targetName, issue.field, issue.pattern);
  }
}

/**
 * Build the host's `scope.targets` resolver from the validated config document.
 *
 * Takes the SAME validated document the single sanctioned reader
 * (`composeAndValidateToolConfig`) already produced — this is a pure builder, it
 * never reads the config file itself (ADR-0023: one reader). The host-owned
 * `targets:` / `globalExcludes:` namespaces were strict-validated whole-document
 * by the composed schema; they are re-parsed here through the same field schemas
 * only to recover their narrowed types (idempotent on already-validated data, no
 * I/O), then each target is registered into a substrate `TargetRegistry` and
 * wrapped in a `TargetResolver` with the bound `resolveTargets` /
 * `applyGlobalExcludes` closures.
 *
 * @param args.document The validated config document from
 *   `composeAndValidateToolConfig`, or an empty object for a config-less run.
 * @returns The `TargetResolver` to attach to `scope.targets`, or `undefined`
 *   when there is no config document or no `targets:` block to resolve.
 */
export function buildTargets(args: { readonly document: unknown }): TargetResolver | undefined {
  const { document } = args;
  if (!isPlainRecord(document)) return undefined;

  // No `targets:` block → no resolver. A document may carry only tool config
  // (graph/sim namespaces) with no file targeting, exactly like a config-less run.
  if (document.targets === undefined) return undefined;

  let targetsRecord: Record<string, unknown>;
  try {
    targetsRecord = targetsRecordSchema.parse(document.targets);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Invalid 'targets:' block in opensip-cli.config.yml: ${detail}`, {
      code: 'CONFIGURATION.TARGETS.INVALID',
    });
  }

  let globalExcludes: readonly string[];
  try {
    globalExcludes = Object.freeze(
      document.globalExcludes === undefined
        ? []
        : [...globalExcludesSchema.parse(document.globalExcludes)],
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(
      `Invalid 'globalExcludes:' block in opensip-cli.config.yml: ${detail}`,
      { code: 'CONFIGURATION.TARGETS.INVALID' },
    );
  }

  const registry = new TargetRegistry();
  for (const [name, entry] of Object.entries(targetsRecord)) {
    const targetEntry = entry as Parameters<typeof toTarget>[1];
    rejectUnsafeConventionPathsForTarget(name, targetEntry.conventions);
    registry.register(toTarget(name, targetEntry));
  }

  return {
    getByName: (name) => registry.getByName(name),
    getAll: () => registry.getAll(),
    getByTag: (tag) => registry.getByTag(tag),
    has: (name) => registry.has(name),
    resolveTargets: (names, rootDir) => {
      const resolved = names
        .map((name) => registry.getByName(name))
        .filter((t): t is Target => t !== undefined);
      return resolveTargets(resolved, rootDir, globalExcludes);
    },
    applyGlobalExcludes: (files, rootDir) => applyGlobalExcludes(files, rootDir, globalExcludes),
    globalExcludes,
  };
}
