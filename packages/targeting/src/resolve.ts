// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Uniform target glob expansion (host substrate)
 *
 * The generic glob mechanics any tool consumes via `scope.targets` (ADR-0037):
 * expand a target's `include` globs to absolute paths, then apply per-target
 * `exclude` AND the project `globalExcludes` uniformly, dedup + sort.
 *
 * There is ONE resolution path. The historical fitness `resolveTargetFiles`
 * (which omitted `globalExcludes`) is gone — both excludes always apply.
 */

import { relative, resolve } from 'node:path';

import { globSync } from 'glob';
import { minimatch, Minimatch } from 'minimatch';

import type { TargetRegistry } from './target-registry.js';
import type { Target } from '@opensip-cli/config';

// Common infrastructure dirs are always ignored to prevent expensive traversals.
const COMMON_IGNORE = ['**/node_modules/**', '**/dist/**', '**/.git/**'];

// =============================================================================
// Global excludes
// =============================================================================

/**
 * Filter a file list against the project `globalExcludes` globs (rootDir-relative,
 * `dot: true`). A no-op when there are no excludes.
 */
export function applyGlobalExcludes(
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
// Single-pass resolver (the ONE public resolveTargets)
// =============================================================================

/**
 * Resolve a set of targets to a deduplicated, sorted list of absolute file
 * paths. Expands each target's `include` globs, then filters out per-target
 * `exclude` AND the project `globalExcludes` uniformly.
 *
 * This is the single resolution path that replaces the dead `resolveTargetFiles`
 * (which omitted `globalExcludes`) and the single-check `resolveTargetGlobs`
 * fallback — both excludes always apply.
 *
 * @param targets - Targets to resolve
 * @param rootDir - Project root for glob resolution
 * @param globalExcludes - Project-wide exclusion globs, applied to every target
 * @returns Sorted, deduplicated array of absolute file paths
 */
export function resolveTargets(
  targets: readonly Target[],
  rootDir: string,
  globalExcludes: readonly string[],
): readonly string[] {
  const files = new Set<string>();

  for (const target of targets) {
    const { include, exclude } = target.config;
    for (const pattern of include) {
      const matches = globSync(pattern, {
        cwd: rootDir,
        ignore: [...exclude],
        absolute: true,
      });
      for (const match of matches) {
        files.add(resolve(match));
      }
    }
  }

  return [...applyGlobalExcludes([...files], rootDir, globalExcludes)].sort();
}

// =============================================================================
// Pre-resolved target file cache (single deduplicated glob pass across targets)
// =============================================================================

/** Assemble a single target's file list from pre-resolved pattern results, applying excludes. */
function assembleTargetFiles(
  targetConfig: { include: readonly string[]; exclude: readonly string[]; name: string },
  patternResults: Map<string, readonly string[]>,
  compiledGlobalExcludes: Minimatch[],
  rootDir: string,
): readonly string[] {
  const files = new Set<string>();
  for (const pattern of targetConfig.include) {
    const matches = patternResults.get(pattern) ?? [];
    for (const match of matches) {
      files.add(match);
    }
  }

  if (targetConfig.exclude.length > 0 || compiledGlobalExcludes.length > 0) {
    const compiledTargetExcludes = targetConfig.exclude.map(
      (ex) => new Minimatch(ex, { dot: true }),
    );
    const allExcludes = [...compiledTargetExcludes, ...compiledGlobalExcludes];
    return [...files]
      .filter((filePath) => !allExcludes.some((m) => m.match(relative(rootDir, filePath))))
      .sort();
  }

  return [...files].sort();
}

/**
 * Collect all unique glob patterns from every registered target, run a single
 * deduplicated glob pass, then partition results per target — applying both
 * per-target `exclude` and the project `globalExcludes` so that downstream
 * per-unit lookups are pure in-memory.
 *
 * This avoids redundant filesystem traversals when targets share common
 * patterns (e.g. multiple targets sharing the same `packages` source glob).
 *
 * @param registry - The target registry to expand
 * @param globalExcludes - Project-wide exclusion globs, applied to every target
 * @param rootDir - Project root for glob resolution
 * @returns Map of target name → sorted, deduplicated absolute file paths
 */
export function preResolveAllTargets(
  registry: TargetRegistry,
  globalExcludes: readonly string[],
  rootDir: string,
): Map<string, readonly string[]> {
  const targets = registry.getAll();
  if (targets.length === 0) return new Map();

  // Collect all unique include patterns across targets
  const allPatterns = new Set<string>();
  for (const target of targets) {
    for (const pattern of target.config.include) {
      allPatterns.add(pattern);
    }
  }

  // Single glob pass for each unique pattern — deduplicated across targets.
  const patternResults = new Map<string, readonly string[]>();
  for (const pattern of allPatterns) {
    const matches = globSync(pattern, {
      cwd: rootDir,
      absolute: true,
      nodir: true,
      ignore: COMMON_IGNORE,
    });
    patternResults.set(
      pattern,
      matches.map((m) => resolve(m)),
    );
  }

  // Pre-compile globalExcludes matchers for reuse across all targets
  const compiledExcludes = globalExcludes.map((pattern) => new Minimatch(pattern, { dot: true }));

  // Assemble per-target file lists by combining pattern results and filtering excludes.
  // Both target-specific excludes AND globalExcludes are applied here so that
  // per-unit resolution is a pure in-memory lookup with no minimatch calls.
  const result = new Map<string, readonly string[]>();
  for (const target of targets) {
    const files = assembleTargetFiles(
      { include: target.config.include, exclude: target.config.exclude, name: target.config.name },
      patternResults,
      compiledExcludes,
      rootDir,
    );
    result.set(target.config.name, files);
  }

  return result;
}
