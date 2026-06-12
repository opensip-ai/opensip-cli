/**
 * @fileoverview Scope-based file resolution for fitness checks
 *
 * Checks declare intent (languages + concerns), targets declare reality
 * (languages + concerns + globs), and this module resolves the match.
 *
 * Performance: all targets are globbed once upfront in buildScopeBasedFileMap.
 * Per-check resolution is a pure in-memory lookup — no redundant I/O.
 */

import {
  applyGlobalExcludes,
  preResolveAllTargets,
  resolveTargets,
} from '@opensip-tools/targeting';

import type { CheckScope } from './check-config.js';
import type { TargetRegistry } from '../targets/target-registry.js';
import type { TargetsConfig } from '../targets/types.js';

// =============================================================================
// Pre-resolved target file cache
// =============================================================================
//
// The generic glob mechanics — `preResolveAllTargets` (deduped multi-target
// glob pass), `resolveTargets` (single-pass include/exclude expansion), and
// `applyGlobalExcludes` — now live ONCE in `@opensip-tools/targeting` (ADR-0037,
// Phase 0) and are imported above. Fitness keeps only the check-domain
// resolution below (`unionTargetFiles`, the 3-tier `resolveFilesForCheck`, and
// `buildScopeBasedFileMap`).

/**
 * Look up pre-resolved files for a set of target names, union and deduplicate.
 */
function unionTargetFiles(
  targetNames: readonly string[],
  resolvedTargets: Map<string, readonly string[]>,
): string[] {
  if (targetNames.length === 1) {
    return [...(resolvedTargets.get(targetNames[0]) ?? [])];
  }
  const files = new Set<string>();
  for (const name of targetNames) {
    const targetFiles = resolvedTargets.get(name);
    if (targetFiles) {
      for (const f of targetFiles) files.add(f);
    }
  }
  return [...files].sort();
}

// =============================================================================
// Global excludes
// =============================================================================

function applyGlobalExcludes(
  files: readonly string[],
  rootDir: string,
  globalExcludes: readonly string[],
): readonly string[] {
  if (globalExcludes.length === 0) return files;

  return files.filter((filePath) => {
    const relativePath = relative(rootDir, filePath);
    return !globalExcludes.some((pattern) => minimatch(relativePath, pattern, { dot: true }));
  });
}

// =============================================================================
// Per-check resolution (pure in-memory, no I/O)
// =============================================================================

/**
 * Resolve file paths for a single check using pre-resolved target files.
 *
 * Resolution order:
 * 1. If checkOverrides has an entry for this slug, use those target(s) directly
 * 2. If scope is declared, match against all targets by languages + concerns
 * 3. If no scope and no override, return undefined (check uses file cache fallback)
 *
 * When pre-resolved targets are provided (from buildScopeBasedFileMap), globalExcludes
 * have already been applied during pre-resolution and are skipped here.
 * When called without pre-resolved targets (single-check fallback), globalExcludes
 * are applied after direct globbing.
 */
/**
 * The project-level resolution environment shared across every check in a
 * single {@link buildScopeBasedFileMap} pass: the target registry, the
 * targets config, the project root, and (when pre-resolved) the cached
 * target→files map. Grouped so per-check resolution stays a 3-arg call.
 */
interface CheckFileResolutionContext {
  registry: TargetRegistry;
  config: TargetsConfig;
  rootDir: string;
  resolvedTargets?: Map<string, readonly string[]>;
}

function resolveFilesForCheck(
  slug: string,
  scope: CheckScope | undefined,
  ctx: CheckFileResolutionContext,
): readonly string[] | undefined {
  const { registry, config, rootDir, resolvedTargets } = ctx;
  const { globalExcludes, checkOverrides } = config;

  // When resolvedTargets is provided, globalExcludes are pre-applied — skip re-filtering
  const maybeApplyExcludes = (files: readonly string[]): readonly string[] =>
    resolvedTargets ? files : applyGlobalExcludes(files, rootDir, globalExcludes);

  // Use pre-resolved cache when available, otherwise fall back to direct glob
  const lookupFiles = (targetRef: string | readonly string[]): string[] => {
    const names = typeof targetRef === 'string' ? [targetRef] : targetRef;
    if (resolvedTargets) {
      return unionTargetFiles(names, resolvedTargets);
    }
    // Fallback: resolve directly via the substrate single-pass resolver
    // (single-check mode without precomputed cache).
    const targets = names
      .map((name) => registry.getByName(name))
      .filter((t): t is NonNullable<typeof t> => t !== undefined);
    return [...resolveTargets(targets, rootDir, globalExcludes)];
  };

  // 1. Check overrides take priority (for marketplace/third-party checks)
  const override = checkOverrides[slug];
  if (override) {
    return maybeApplyExcludes(lookupFiles(override));
  }

  // 2. Scope-based matching
  if (scope && (scope.languages.length > 0 || scope.concerns.length > 0)) {
    const matchedTargets = registry.findByScope(scope.languages, scope.concerns);
    if (matchedTargets.length === 0) {
      return [];
    }
    const names = matchedTargets.map((t) => t.config.name);
    return maybeApplyExcludes(lookupFiles(names));
  }

  // 3. No scope, no override — undefined signals "use file cache fallback"
  return undefined;
}

/**
 * Build the complete check-to-files map for all checks with scopes or overrides.
 *
 * All targets are globbed once upfront. Per-check resolution is a pure
 * in-memory lookup against the pre-resolved file lists.
 */
export function buildScopeBasedFileMap(
  checks: readonly { slug: string; scope?: CheckScope }[],
  registry: TargetRegistry,
  config: TargetsConfig,
  rootDir: string,
): Map<string, readonly string[]> {
  // Pre-resolve all targets once — deduplicated glob pass across all targets.
  // GlobalExcludes are applied during pre-resolution so per-check lookups are pure in-memory.
  const resolvedTargets = preResolveAllTargets(registry, config.globalExcludes, rootDir);
  const ctx: CheckFileResolutionContext = { registry, config, rootDir, resolvedTargets };

  const result = new Map<string, readonly string[]>();

  for (const check of checks) {
    const files = resolveFilesForCheck(check.slug, check.scope, ctx);
    if (files !== undefined) {
      result.set(check.slug, files);
    }
  }

  return result;
}
