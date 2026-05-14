// @fitness-ignore-file public-api-jsdoc -- internal framework module; public API documented at package level
/**
 * @fileoverview In-memory file cache for fitness checks
 *
 * Simple file content cache with optional prewarming.
 * Used by all checks during a run for efficient file access.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { ValidationError } from '@opensip-tools/core'
import { glob } from 'glob'

/**
 * Prewarm statistics.
 */
interface PrewarmStats {
  /** Number of files loaded */
  readonly filesLoaded: number
  /** Duration in milliseconds */
  readonly durationMs: number
  /** Total bytes loaded */
  readonly totalBytes: number
}

/**
 * Simple in-memory file cache.
 *
 * Usage:
 * 1. Call prewarm() before running checks (loads file contents)
 * 2. Use get() to read file contents (falls back to disk if not cached)
 * 3. Call clear() after checks complete
 */
const PREWARM_BATCH_SIZE = 100

class FileCache {
  private readonly cache = new Map<string, string>()
  private _prewarmed = false
  private _cleared = false
  private _autoClearTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Prewarm the cache by loading all files matching patterns.
   * @param cwd - Working directory for file resolution
   * @param patterns - Glob patterns to prewarm file contents for
   * @returns Prewarm statistics
   */
  async prewarm(cwd: string, patterns: readonly string[]): Promise<PrewarmStats> {
    const start = Date.now()
    let totalBytes = 0

    // Find all matching files for content caching
    const allFiles = new Set<string>()
    for (const pattern of patterns) {
      // @fitness-ignore-next-line performance-anti-patterns -- sequential glob calls: each pattern must resolve before deduplication
      const files = await glob(pattern, {
        cwd,
        absolute: true,
        nodir: true,
        ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
      })
      for (const file of files) {
        allFiles.add(file)
      }
    }

    // Load file contents in parallel batches
    const files = [...allFiles]

    for (let i = 0; i < files.length; i += PREWARM_BATCH_SIZE) {
      const batch = files.slice(i, i + PREWARM_BATCH_SIZE)
      // @fitness-ignore-next-line performance-anti-patterns -- intentional batching: limits concurrent file reads to control memory pressure
      const results = await Promise.allSettled(
        batch.map(async (filePath) => {
          const stats = await fs.stat(filePath)
          if (stats.isDirectory()) {
            return null
          }
          const content = await fs.readFile(filePath, 'utf8')
          return { filePath, content }
        }),
      )

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value !== null) {
          this.cache.set(result.value.filePath, result.value.content)
          totalBytes += result.value.content.length
        }
      }
    }

    this._prewarmed = true
    this._cleared = false
    this.scheduleAutoClear()
    const durationMs = Date.now() - start

    return {
      filesLoaded: this.cache.size,
      durationMs,
      totalBytes,
    }
  }

  /**
   * Get file content from cache, falling back to disk if not cached.
   * @throws {Error} If the path is a directory instead of a file
   */
  /** Synchronously check if a file is in cache. Returns content or undefined. */
  getCached(filePath: string): string | undefined {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath)
    return this.cache.get(absolutePath)
  }

  async get(filePath: string): Promise<string> {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath)

    const cached = this.cache.get(absolutePath)
    if (cached !== undefined) {
      return cached
    }

    const stats = await fs.stat(absolutePath)
    if (stats.isDirectory()) {
      // @fitness-ignore-next-line result-pattern-consistency -- internal method, exceptions propagate to public Result boundary
      throw new ValidationError(`Cannot read directory as file: ${absolutePath}`, { code: 'VALIDATION.FITNESS.DIRECTORY_AS_FILE' })
    }
    const content = await fs.readFile(absolutePath, 'utf8')

    this.cache.set(absolutePath, content)

    return content
  }

  /**
   * Check if a file exists (in cache or on disk).
   */
  async exists(filePath: string): Promise<boolean> {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath)

    if (this.cache.has(absolutePath)) {
      return true
    }

    try {
      await fs.access(absolutePath)
      return true
    } catch {
      // @swallow-ok File access check failed — treat as not accessible
      return false
    }
  }

  /**
   * Clear the cache. Must be called after checks complete.
   */
  clear(): void {
    this.cache.clear()
    this._prewarmed = false
    this._cleared = true
    if (this._autoClearTimer) {
      clearTimeout(this._autoClearTimer)
      this._autoClearTimer = null
    }
  }

  /**
   * Get all cached file paths.
   * Returns the paths of all files loaded during prewarm or on-demand reads.
   */
  paths(): readonly string[] {
    return [...this.cache.keys()].sort()
  }

  /**
   * Get cache statistics.
   */
  /** Auto-clear after timeout to prevent memory leaks from missed lifecycle cleanup */
  private scheduleAutoClear(): void {
    if (this._autoClearTimer) {
      clearTimeout(this._autoClearTimer)
    }
    this._autoClearTimer = setTimeout(() => {
      if (this.cache.size > 0) {
        this.clear()
      }
    }, 10 * 60 * 1000) // 10 minutes
    // Unref so the timer doesn't keep the process alive
    this._autoClearTimer.unref()
  }

  get stats(): {
    size: number
    prewarmed: boolean
    cleared: boolean
  } {
    return {
      size: this.cache.size,
      prewarmed: this._prewarmed,
      cleared: this._cleared,
    }
  }
}

/**
 * Shared file cache instance.
 */
export const fileCache = new FileCache()

/**
 * Default patterns to prewarm for fitness checks.
 */
export const DEFAULT_PREWARM_PATTERNS = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.json',
  '**/*.md',
] as const
