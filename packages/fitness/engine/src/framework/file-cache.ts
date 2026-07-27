/**
 * @fileoverview In-memory file cache for fitness checks
 *
 * Simple file content cache with optional prewarming.
 * Used by all checks during a run for efficient file access.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { SystemError, ValidationError, currentLogger } from '@opensip-cli/core';
import { glob } from 'glob';

import { fitnessErrorCatalog } from '../errors/fitness-error-catalog.js';

// Plan 01 clean break: registered definitions replace bare code literals that only
// resolved through the family fallback.
const FILE_TOO_LARGE = fitnessErrorCatalog.require('FIT.FITNESS.FILE_TOO_LARGE');
const PATH_REJECTED = fitnessErrorCatalog.require('FIT.FITNESS.PATH_REJECTED');

/**
 * Prewarm statistics.
 */
interface PrewarmStats {
  /** Number of files loaded */
  readonly filesLoaded: number;
  /** Duration in milliseconds */
  readonly durationMs: number;
  /** Total bytes loaded */
  readonly totalBytes: number;
}

/**
 * Simple in-memory file cache.
 *
 * Usage:
 * 1. Call prewarm() before running checks (loads file contents)
 * 2. Use get() to read file contents (falls back to disk if not cached)
 * 3. Call clear() after checks complete
 */
const PREWARM_BATCH_SIZE = 100;

/** In-memory file cache with optional prewarm for fitness check runs. */

/**
 * A rejected prewarm is COUNTED, not merely skipped.
 *
 * Dropping rejections silently made an unreadable tree (EACCES, EMFILE) look exactly like a
 * fully-warmed cache. The later explicit read does fail loudly, but only for files a check
 * happens to open, so a partially-warmed cache was otherwise invisible.
 */
function countRejected(results: readonly PromiseSettledResult<unknown>[]): number {
  return results.filter((result) => result.status === 'rejected').length;
}

/**
 * Surface an incomplete prewarm without failing it.
 *
 * Prewarm is an optimisation, and a check that needs one of these files still fails loudly on
 * its own read. What must not happen is a partially-warmed cache reporting as complete (D7).
 */
function reportPrewarmGaps(rejected: number, loaded: number): void {
  if (rejected === 0) return;
  try {
    currentLogger().warn({
      evt: 'fitness.file_cache.prewarm_incomplete',
      rejected,
      loaded,
      msg: 'Some files could not be pre-read; checks that need them will read them directly',
    });
  } catch {
    // @swallow-ok a diagnostic must not fail the prewarm it is describing
  }
}

/**
 * Per-run content cache for files a check reads.
 *
 * Bounded and run-scoped: it exists so that N checks over the same file perform one read, not N.
 * Prewarm gaps are reported rather than silently yielding an empty cache.
 */
export class FileCache {
  private readonly cache = new Map<string, string>();
  private _prewarmed = false;
  private _cleared = false;
  private _prewarmSnapshot: readonly string[] | undefined;

  /**
   * Prewarm the cache by loading all files matching patterns.
   * @param cwd - Working directory for file resolution
   * @param patterns - Glob patterns to prewarm file contents for
   * @returns Prewarm statistics
   */
  async prewarm(cwd: string, patterns: readonly string[]): Promise<PrewarmStats> {
    const start = Date.now();
    let totalBytes = 0;

    // Find all matching files for content caching
    const allFiles = new Set<string>();
    for (const pattern of patterns) {
      const files = await glob(pattern, {
        cwd,
        absolute: true,
        nodir: true,
        ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
      });
      for (const file of files) {
        allFiles.add(file);
      }
    }

    // Load file contents in parallel batches
    const files = [...allFiles];

    let prewarmRejected = 0;
    for (let i = 0; i < files.length; i += PREWARM_BATCH_SIZE) {
      const batch = files.slice(i, i + PREWARM_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (filePath) => {
          const stats = await fs.stat(filePath);
          if (stats.isDirectory()) {
            return null;
          }
          const content = await fs.readFile(filePath, 'utf8');
          return { filePath, content };
        }),
      );

      prewarmRejected += countRejected(results);

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value !== null) {
          const { filePath, content } = result.value;
          // Enforce the same 10 MiB per-file limit that ExecutionContext.readFile
          // guarantees to checks. Huge files are skipped during prewarm (they will
          // still fail loudly with a clear error if a check later tries to read them
          // explicitly). This keeps the cache from holding data that no check is
          // allowed to consume.
          if (content.length > 10_000_000) {
            continue;
          }
          this.cache.set(filePath, content);
          totalBytes += content.length;
        }
      }
    }

    this._prewarmed = true;
    // Freeze the post-prewarm universe: scope-empty (universal) checks read
    // THIS snapshot, never the live cache — on-demand reads by concurrently
    // running scoped checks would otherwise widen their file set
    // scheduling-dependently (nondeterministic findings run-to-run).
    // The execution universe is every discovered path, not only successful
    // cache reads. A rejected prewarm must fall through to the check's ordinary
    // read boundary, where it becomes visible degradation instead of vanishing.
    this._prewarmSnapshot = Object.freeze([...allFiles].sort());
    this._cleared = false;
    const durationMs = Date.now() - start;
    reportPrewarmGaps(prewarmRejected, this.cache.size);

    return {
      filesLoaded: this.cache.size,
      durationMs,
      totalBytes,
    };
  }

  /**
   * Get file content from cache, falling back to disk if not cached.
   * @throws {Error} If the path is a directory instead of a file
   */
  /** Synchronously check if a file is in cache. Returns content or undefined. */
  getCached(filePath: string): string | undefined {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    return this.cache.get(absolutePath);
  }

  async get(filePath: string): Promise<string> {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

    const cached = this.cache.get(absolutePath);
    if (cached !== undefined) {
      return cached;
    }

    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory()) {
      throw new ValidationError(`Cannot read directory as file: ${absolutePath}`, {
        code: PATH_REJECTED.code,
        definition: PATH_REJECTED,
        metadata: { condition: 'directory-as-file' },
      });
    }
    const content = await fs.readFile(absolutePath, 'utf8');

    if (content.length > 10_000_000) {
      // Consistent with ExecutionContext.readFile and prewarm: never surface
      // >10 MiB of content to a check. Throw here so even direct cache.get
      // callers (and any future direct users of fileCache) are protected.
      throw new SystemError(`File too large (${content.length} bytes, max 10MB): ${absolutePath}`, {
        code: FILE_TOO_LARGE.code,
        definition: FILE_TOO_LARGE,
      });
    }

    this.cache.set(absolutePath, content);

    return content;
  }

  /**
   * Check if a file exists (in cache or on disk).
   */
  async exists(filePath: string): Promise<boolean> {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

    if (this.cache.has(absolutePath)) {
      return true;
    }

    try {
      await fs.access(absolutePath);
      return true;
    } catch {
      // @swallow-ok File access check failed — treat as not accessible
      return false;
    }
  }

  /**
   * Clear the cache. Must be called after checks complete.
   */
  clear(): void {
    this.cache.clear();
    this._prewarmed = false;
    this._prewarmSnapshot = undefined;
    this._cleared = true;
  }

  /**
   * Get all cached file paths.
   * Returns the paths of all files loaded during prewarm or on-demand reads.
   */
  paths(): readonly string[] {
    return [...this.cache.keys()].sort();
  }

  /**
   * The immutable file universe captured when prewarm completed, or
   * `undefined` when this cache was never prewarmed (tests, ad-hoc use).
   * Later on-demand reads grow {@link paths} but never this snapshot.
   */
  prewarmedPaths(): readonly string[] | undefined {
    return this._prewarmSnapshot;
  }

  /**
   * Get cache statistics.
   */
  get stats(): {
    size: number;
    prewarmed: boolean;
    cleared: boolean;
  } {
    return {
      size: this.cache.size,
      prewarmed: this._prewarmed,
      cleared: this._cleared,
    };
  }
}

/**
 * TEST-ONLY shared file cache instance.
 *
 * Production resolves the per-run cache from `currentScope()?.fitness?.fileCache`
 * (created once per run by the fitness tool's `contributeScope()`); after
 * parallel-tool-invocations Phase 1, ZERO production code reads this singleton.
 * It is retained solely for isolated unit tests that exercise the cache without
 * a scope (they seed/clear it directly, or pass it explicitly as
 * `options.fileCache`). New production imports are forbidden by the
 * `no-module-level-run-state` dogfood check (Phase 3).
 * `no-module-singleton.mjs` keeps a definition-file exemption for this symbol
 * only (`EXEMPT_BY_FILE`).
 */
export const fileCache = new FileCache();

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
] as const;
