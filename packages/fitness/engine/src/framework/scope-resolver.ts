/**
 * @fileoverview Scope-based file resolution for fitness checks
 *
 * Checks declare intent (languages + concerns), targets declare reality
 * (languages + concerns + globs), and this module resolves the match.
 *
 * Performance: all targets are globbed once upfront in buildScopeBasedFileMap.
 * Per-check resolution is a pure in-memory lookup — no redundant I/O.
 */

import { relative, resolve } from 'node:path'

import { globSync } from 'glob'
import { minimatch, Minimatch } from 'minimatch'

import type { CheckScope } from './check-config.js'
import type { TargetRegistry } from '../targets/target-registry.js'
import type { Target, TargetsConfig } from '../targets/types.js'

// =============================================================================
// Pre-resolved target file cache
// =============================================================================

/** Assemble a single target's file list from pre-resolved pattern results, applying excludes. */
function assembleTargetFiles(
  targetConfig: { include: readonly string[]; exclude: readonly string[]; name: string },
  patternResults: Map<string, readonly string[]>,
  compiledGlobalExcludes: Minimatch[],
  rootDir: string,
): readonly string[] {
  const files = new Set<string>()
  for (const pattern of targetConfig.include) {
    const matches = patternResults.get(pattern) ?? []
    for (const match of matches) {
      files.add(match)
    }
  }

  if (targetConfig.exclude.length > 0 || compiledGlobalExcludes.length > 0) {
    const compiledTargetExcludes = targetConfig.exclude.map((ex) => new Minimatch(ex, { dot: true }))
    const allExcludes = [...compiledTargetExcludes, ...compiledGlobalExcludes]
    for (const filePath of files) {
      const rel = relative(rootDir, filePath)
      if (allExcludes.some((m) => m.match(rel))) {
        files.delete(filePath)
      }
    }
  }

  return [...files].sort()
}

/**
 * Collect all unique glob patterns and ignore patterns from all targets,
 * run a single deduplicated glob pass, then partition results per target.
 *
 * This avoids redundant filesystem traversals when targets share common
 * patterns (e.g. multiple targets including "packages/star/src/starstar/star.ts").
 */
function preResolveAllTargets(
  registry: TargetRegistry,
  config: TargetsConfig,
  rootDir: string,
): Map<string, readonly string[]> {
  const targets = registry.getAll()
  if (targets.length === 0) return new Map()

  // Collect all unique include patterns across targets
  const allPatterns = new Set<string>()
  for (const target of targets) {
    for (const pattern of target.config.include) {
      allPatterns.add(pattern)
    }
  }

  // Single glob pass for each unique pattern — deduplicated across targets.
  // Common infrastructure dirs are always ignored to prevent expensive traversals.
  const COMMON_IGNORE = ['**/node_modules/**', '**/dist/**', '**/.git/**']
  const patternResults = new Map<string, readonly string[]>()
  for (const pattern of allPatterns) {
    const matches = globSync(pattern, {
      cwd: rootDir,
      absolute: true,
      nodir: true,
      ignore: COMMON_IGNORE,
    })
    patternResults.set(pattern, matches.map((m) => resolve(m)))
  }

  // Pre-compile globalExcludes matchers for reuse across all targets
  const { globalExcludes } = config
  const compiledExcludes = globalExcludes.map((pattern) => new Minimatch(pattern, { dot: true }))

  // Assemble per-target file lists by combining pattern results and filtering excludes.
  // Both target-specific excludes AND globalExcludes are applied here so that
  // per-check resolution is a pure in-memory lookup with no minimatch calls.
  const result = new Map<string, readonly string[]>()
  for (const target of targets) {
    const files = assembleTargetFiles(
      { include: target.config.include, exclude: target.config.exclude, name: target.config.name },
      patternResults, compiledExcludes, rootDir,
    )
    result.set(target.config.name, files)
  }

  return result
}

/**
 * Resolve a single target's include/exclude globs to absolute file paths.
 * Used by the resolveFilesForCheck fallback path (single-check mode).
 */
function resolveTargetGlobs(target: Target, rootDir: string): string[] {
  const files = new Set<string>()
  const { include, exclude } = target.config

  for (const pattern of include) {
    const matches = globSync(pattern, {
      cwd: rootDir,
      ignore: [...exclude],
      absolute: true,
    })
    for (const match of matches) {
      files.add(resolve(match))
    }
  }

  return [...files].sort()
}

/**
 * Look up pre-resolved files for a set of target names, union and deduplicate.
 */
function unionTargetFiles(
  targetNames: readonly string[],
  resolvedTargets: Map<string, readonly string[]>,
): string[] {
  if (targetNames.length === 1) {
    return [...(resolvedTargets.get(targetNames[0]) ?? [])]
  }
  const files = new Set<string>()
  for (const name of targetNames) {
    const targetFiles = resolvedTargets.get(name)
    if (targetFiles) {
      for (const f of targetFiles) files.add(f)
    }
  }
  return [...files].sort()
}

// =============================================================================
// Global excludes
// =============================================================================

function applyGlobalExcludes(
  files: readonly string[],
  rootDir: string,
  globalExcludes: readonly string[],
): readonly string[] {
  if (globalExcludes.length === 0) return files

  return files.filter((filePath) => {
    const relativePath = relative(rootDir, filePath)
    return !globalExcludes.some((pattern) => minimatch(relativePath, pattern, { dot: true }))
  })
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
function resolveFilesForCheck(
  slug: string,
  scope: CheckScope | undefined,
  registry: TargetRegistry,
  config: TargetsConfig,
  rootDir: string,
  resolvedTargets?: Map<string, readonly string[]>,
): readonly string[] | undefined {
  const { globalExcludes, checkOverrides } = config

  // When resolvedTargets is provided, globalExcludes are pre-applied — skip re-filtering
  const maybeApplyExcludes = (files: readonly string[]): readonly string[] =>
    resolvedTargets ? files : applyGlobalExcludes(files, rootDir, globalExcludes)

  // Use pre-resolved cache when available, otherwise fall back to direct glob
  const lookupFiles = (targetRef: string | readonly string[]): string[] => {
    const names = typeof targetRef === 'string' ? [targetRef] : targetRef
    if (resolvedTargets) {
      return unionTargetFiles(names, resolvedTargets)
    }
    // Fallback: resolve directly (single-check mode without precomputed cache)
    const targets = names
      .map((name) => registry.getByName(name))
      .filter((t): t is NonNullable<typeof t> => t !== undefined)
    const files = new Set<string>()
    for (const target of targets) {
      for (const f of resolveTargetGlobs(target, rootDir)) files.add(f)
    }
    return [...files].sort()
  }

  // 1. Check overrides take priority (for marketplace/third-party checks)
  const override = checkOverrides[slug]
  if (override) {
    return maybeApplyExcludes(lookupFiles(override))
  }

  // 2. Scope-based matching
  if (scope && (scope.languages.length > 0 || scope.concerns.length > 0)) {
    const matchedTargets = registry.findByScope(scope.languages, scope.concerns)
    if (matchedTargets.length === 0) {
      return []
    }
    const names = matchedTargets.map((t) => t.config.name)
    return maybeApplyExcludes(lookupFiles(names))
  }

  // 3. No scope, no override — undefined signals "use file cache fallback"
  return undefined
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
  const resolvedTargets = preResolveAllTargets(registry, config, rootDir)

  const result = new Map<string, readonly string[]>()

  for (const check of checks) {
    const files = resolveFilesForCheck(check.slug, check.scope, registry, config, rootDir, resolvedTargets)
    if (files !== undefined) {
      result.set(check.slug, files)
    }
  }

  return result
}
