/**
 * @fileoverview PathMatcher - Strategy pattern for file matching
 *
 * Provides glob-based file matching with include/exclude patterns.
 * Supports lazy evaluation and composition.
 */

import * as path from 'node:path'

import { glob } from 'glob'
import { minimatch } from 'minimatch'

/**
 * Options for PathMatcher.
 */
export interface PathMatcherOptions {
  /** Root directory to search from */
  readonly cwd: string
  /** Glob patterns to include */
  readonly include: readonly string[]
  /** Glob patterns to exclude */
  readonly exclude: readonly string[]
  /** Additional exclusion patterns (combined with exclude) */
  readonly additionalExcludes?: readonly string[]
}

/**
 * Result of file matching operation.
 */
export interface MatchResult {
  /** Matched files (absolute paths) */
  readonly files: readonly string[]
  /** Files that were excluded */
  readonly excluded: readonly string[]
  /** Time taken for glob operation in ms */
  readonly durationMs: number
}

/**
 * Strategy for matching files based on glob patterns.
 * Supports both custom patterns and composition.
 *
 * @example
 * ```typescript
 * const matcher = PathMatcher.create({
 *   cwd: '/path/to/repo',
 *   include: ['src/**\/*.ts'],
 *   exclude: ['**\/__tests__/**'],
 * });
 * const files = await matcher.files();
 * ```
 */
export class PathMatcher {
  private constructor(private readonly options: PathMatcherOptions) {}

  /**
   * Create a PathMatcher from options.
   */
  static create(options: PathMatcherOptions): PathMatcher {
    return new PathMatcher(options)
  }

  /**
   * Get all matching files.
   * @returns Array of absolute file paths matching the patterns
   */
  async files(): Promise<readonly string[]> {
    const result = await this.match()
    return result.files
  }

  /**
   * Get detailed match result including timing.
   */
  async match(): Promise<MatchResult> {
    const start = Date.now()

    const allExcludes = [...this.options.exclude, ...(this.options.additionalExcludes ?? [])]

    // Run glob for all include patterns
    const matchedSets = await Promise.all(
      this.options.include.map((pattern) =>
        glob(pattern, {
          cwd: this.options.cwd,
          absolute: true,
          nodir: true,
          ignore: allExcludes,
        }),
      ),
    )

    // Combine and deduplicate results
    const allMatched = new Set<string>()
    for (const matches of matchedSets) {
      for (const file of matches) {
        allMatched.add(path.normalize(file))
      }
    }

    const files = [...allMatched].sort()
    const durationMs = Date.now() - start

    return {
      files,
      excluded: [],
      durationMs,
    }
  }

  /**
   * Check if a file matches the patterns.
   * @param filePath - Absolute path to check
   * @returns True if file matches include patterns and is not excluded
   */
  matches(filePath: string): boolean {
    const relativePath = path.relative(this.options.cwd, filePath)

    const matchesInclude = this.options.include.some((pattern) =>
      minimatch(relativePath, pattern, { dot: true }),
    )

    if (!matchesInclude) {
      return false
    }

    const allExcludes = [...this.options.exclude, ...(this.options.additionalExcludes ?? [])]

    const matchesExclude = allExcludes.some((pattern) =>
      minimatch(relativePath, pattern, { dot: true }),
    )

    return !matchesExclude
  }

  /**
   * Create a new PathMatcher with additional exclusions.
   */
  withExcludes(additionalExcludes: readonly string[]): PathMatcher {
    if (!Array.isArray(additionalExcludes)) {
      return this
    }
    return new PathMatcher({
      ...this.options,
      additionalExcludes: [...(this.options.additionalExcludes ?? []), ...additionalExcludes],
    })
  }

  /**
   * Create a new PathMatcher that only includes TypeScript files.
   */
  typescriptOnly(): PathMatcher {
    return new PathMatcher({
      ...this.options,
      include: this.options.include.map((pattern) => {
        if (pattern.endsWith('/*') || pattern.endsWith('/**/*')) {
          const base = pattern.replace(/\/\*+$/, '')
          return `${base}/**/*.{ts,tsx}`
        }
        if (!pattern.includes('.')) {
          return `${pattern}/**/*.{ts,tsx}`
        }
        return pattern
      }),
    })
  }

  /**
   * Create a new PathMatcher that excludes test files.
   */
  noTests(): PathMatcher {
    return this.withExcludes([
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
    ])
  }

  /** Get the current working directory. */
  get cwd(): string {
    return this.options.cwd
  }

  /** Get the include patterns. */
  get includePatterns(): readonly string[] {
    return this.options.include
  }

  /** Get the exclude patterns. */
  get excludePatterns(): readonly string[] {
    return [...this.options.exclude, ...(this.options.additionalExcludes ?? [])]
  }
}
