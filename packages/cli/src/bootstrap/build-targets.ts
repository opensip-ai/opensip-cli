/**
 * build-targets — the host's once-per-run construction of `scope.targets`
 * (ADR-0037, generic-targeting-runtime Phase 1).
 *
 * The composition root reads the already-resolved config document, parses the
 * host-owned `targets:` / `globalExcludes:` blocks through the
 * `@opensip-tools/config` Zod field schemas, registers each target into the
 * substrate `TargetRegistry`, and returns a `TargetResolver` — the structural
 * scope-slot shape `core` declares — wrapping the registry plus the bound
 * `resolveTargets` / `applyGlobalExcludes` closures + the project
 * `globalExcludes`. The CLI bootstrap attaches the result as `scope.targets`,
 * mirroring how `composeAndValidateToolConfig` produces `scope.toolConfig`.
 *
 * The host build is the GENERIC half only: it does NOT validate `checkOverrides`
 * (a check-slug concept) — that cross-validation stays in
 * `@opensip-tools/fitness`'s loader (Phase 2). A run with no config document, or
 * a config document with no `targets:` block, yields `undefined` — exactly like
 * a config-less `toolConfig`.
 */

import { globalExcludesSchema, targetsRecordSchema, type Target } from '@opensip-tools/config';
import { type TargetResolver } from '@opensip-tools/core';
import { TargetRegistry, applyGlobalExcludes, resolveTargets } from '@opensip-tools/targeting';

/**
 * Default per-target exclusion globs, applied when a target declares no
 * explicit `exclude`. Mirrors the historical fitness loader so the host build
 * is byte-identical to the registry fitness builds today (the source the
 * Phase 2 cutover replaces).
 */
const DEFAULT_EXCLUDES: readonly string[] = ['**/node_modules/**', '**/dist/**'];

/** A plain-object guard that treats arrays and null as non-objects. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  });
  return Object.freeze({ config });
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
  if (!isPlainObject(document)) return undefined;

  // No `targets:` block → no resolver. A document may carry only tool config
  // (graph/sim namespaces) with no file targeting, exactly like a config-less run.
  if (document.targets === undefined) return undefined;

  const targets = targetsRecordSchema.parse(document.targets);
  const globalExcludes: readonly string[] = Object.freeze(
    document.globalExcludes === undefined
      ? []
      : [...globalExcludesSchema.parse(document.globalExcludes)],
  );

  const registry = new TargetRegistry();
  for (const [name, entry] of Object.entries(targets)) {
    registry.register(toTarget(name, entry));
  }

  return {
    getByName: (name) => registry.getByName(name),
    // @fitness-ignore-next-line batch-operation-limits -- getAll() over the project's declared target set (a handful of named file-sets per config document), bounded like core's tool registry getAll.
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
