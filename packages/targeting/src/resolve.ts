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

import { isPathInside } from '@opensip-cli/core';
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
  return files.filter((filePath) => {
    // Hard guard: anything not inside the project root after realpath resolution
    // is never returned, regardless of globalExcludes patterns. This closes
    // symlink / ../include / absolute-outside escape vectors.
    if (!isPathInside(filePath, rootDir)) return false;
    if (globalExcludes.length === 0) return true;
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

  // Pre-compile globals once for the whole call (mirrors preResolveAllTargets).
  const compiledGlobalExcludes = globalExcludes.map(
    (pattern) => new Minimatch(pattern, { dot: true }),
  );

  for (const target of targets) {
    const { include, exclude } = target.config;
    for (const pattern of include) {
      const matches = globSync(pattern, {
        cwd: rootDir,
        absolute: true,
        nodir: true,
        ignore: [...COMMON_IGNORE, ...exclude],
      });
      // Use the *exact same* post-glob filter as the pre-resolve assemble path
      // (inside-root + target exclude + globalExcludes, dedup+sort) to guarantee
      // identical output sets for equivalent inputs.
      const filtered = filterOneTargetFiles(
        matches.map((m) => resolve(m)),
        exclude,
        compiledGlobalExcludes,
        rootDir,
      );
      for (const f of filtered) files.add(f);
    }
  }

  // applyGlobalExcludes is still used by the legacy direct-file-cache fallback
  // paths and external callers; keep it, but the per-target results above have
  // already folded globals for the main resolveTargets contract.
  return [...files].sort();
}

// =============================================================================
// Shared post-glob filtering (used by both resolve paths for exact parity)
// =============================================================================

/**
 * Filter a raw list of (already inside-root) absolute paths for one target:
 * - apply the target's own `exclude` globs
 * - apply the project `globalExcludes`
 * - dedup + sort
 *
 * This helper is the single source of truth for "after glob, apply this target's
 * exclude + globals" so that the single-pass `resolveTargets` and the
 * optimized `preResolveAllTargets` (which does a cross-target deduped glob then
 * per-target re-filter) produce byte-identical results for the same inputs.
 */
function filterOneTargetFiles(
  rawMatches: readonly string[],
  targetExclude: readonly string[],
  compiledGlobalExcludes: Minimatch[],
  rootDir: string,
): readonly string[] {
  const files = new Set<string>();
  for (const m of rawMatches) {
    if (isPathInside(m, rootDir)) files.add(m);
  }
  const hasTargetExcludes = targetExclude.length > 0;
  const hasGlobals = compiledGlobalExcludes.length > 0;
  if (hasTargetExcludes || hasGlobals) {
    const compiledTargetExcludes = hasTargetExcludes
      ? targetExclude.map((ex) => new Minimatch(ex, { dot: true }))
      : [];
    const allExcludes = [...compiledTargetExcludes, ...compiledGlobalExcludes];
    return [...files]
      .filter((filePath) => !allExcludes.some((m) => m.match(relative(rootDir, filePath))))
      .sort();
  }
  return [...files].sort();
}

/** Assemble a single target's file list from pre-resolved pattern results, applying excludes. */
function assembleTargetFiles(
  targetConfig: {
    include: readonly string[];
    exclude: readonly string[];
    name: string;
  },
  patternResults: Map<string, readonly string[]>,
  compiledGlobalExcludes: Minimatch[],
  rootDir: string,
): readonly string[] {
  // Collect raw matches for this target's includes (the shared glob may have
  // over-collected for shared patterns; we filter precisely here).
  const raw: string[] = [];
  for (const pattern of targetConfig.include) {
    const matches = patternResults.get(pattern) ?? [];
    raw.push(...matches);
  }
  return filterOneTargetFiles(raw, targetConfig.exclude, compiledGlobalExcludes, rootDir);
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
      {
        include: target.config.include,
        exclude: target.config.exclude,
        name: target.config.name,
      },
      patternResults,
      compiledExcludes,
      rootDir,
    );
    result.set(target.config.name, files);
  }

  return result;
}
