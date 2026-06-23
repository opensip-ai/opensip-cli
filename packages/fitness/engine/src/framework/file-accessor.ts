/**
 * @fileoverview FileAccessor implementation for lazy file loading
 *
 * Provides lazy-loading file access with LRU caching for
 * analyzeAll mode checks that need to correlate across files.
 */

import * as fs from 'node:fs/promises';

import { ValidationError, applyContentFilter } from '@opensip-cli/core';

import type { FileAccessor } from './check-config.js';
import type { FileCache } from './file-cache.js';

// =============================================================================
// LRU CACHE
// =============================================================================

class LRUCache<K, V> {
  private readonly cache: Map<K, V>;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.cache = new Map();
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    // in-memory: single-threaded Node.js access pattern
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

// =============================================================================
// FILE ACCESSOR IMPLEMENTATION
// =============================================================================

/** Options for creating a FileAccessor instance. */
export interface FileAccessorOptions {
  readonly cacheCapacity?: number;
  readonly signal?: AbortSignal;
  /**
   * Content filtering applied before returning file content. See
   * BaseCheckConfig.contentFilter for the canonical doc.
   */
  readonly contentFilter?: 'raw' | 'strip-strings' | 'strip-strings-and-comments';
  /**
   * Per-run scope cache (`scope.fitness.fileCache`). When present, `read()`
   * resolves prewarmed content from it before hitting disk — closing the
   * analyzeAll global-cache miss (parallel-tool-invocations Phase 1). Optional:
   * the no-scope single-check direct path and isolated unit tests legitimately
   * have no scope cache and fall through to a disk read. The production
   * guarantee that the analyzeAll call site passes the scope cache is enforced
   * at the `createExecutionContext` resolve-or-throw boundary + a call-site test,
   * not by a required parameter.
   */
  readonly fileCache?: FileCache;
}

const DEFAULT_CACHE_CAPACITY = 100;

/** FileAccessor implementation with LRU caching and abort signal support. */
class FileAccessorImpl implements FileAccessor {
  readonly paths: readonly string[];
  private readonly cache: LRUCache<string, string>;
  private readonly pathSet: Set<string>;
  private readonly signal?: AbortSignal;
  private readonly contentFilterMode?: FileAccessorOptions['contentFilter'];
  /** Per-run scope cache; undefined on the no-scope direct path (→ disk read). */
  private readonly fileCache?: FileCache;

  constructor(filePaths: readonly string[], options: FileAccessorOptions = {}) {
    this.paths = filePaths;
    this.pathSet = new Set(filePaths);
    this.cache = new LRUCache(options.cacheCapacity ?? DEFAULT_CACHE_CAPACITY);
    this.signal = options.signal;
    this.contentFilterMode = options.contentFilter;
    this.fileCache = options.fileCache;
  }

  async read(filePath: string): Promise<string> {
    // in-memory: single-threaded Node.js access pattern
    this.signal?.throwIfAborted();

    if (!this.pathSet.has(filePath)) {
      // @fitness-ignore-next-line result-pattern-consistency -- internal method, exceptions propagate to public Result boundary
      throw new ValidationError(
        `File path not in matched set: ${filePath}. ` +
          `Only paths from the 'paths' property can be read.`,
        { code: 'VALIDATION.FITNESS.PATH_NOT_IN_SET' },
      );
    }

    const cached = this.cache.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    // Try the per-run scope cache first (populated by prewarm or previous
    // checks). On the no-scope direct path no cache is injected, so we fall
    // straight through to the disk read below (parallel-tool-invocations Phase 1
    // — the module-singleton read is gone).
    let content = this.fileCache?.getCached(filePath);
    if (content === undefined) {
      const fileStats = await fs.stat(filePath);
      if (fileStats.size > 10_000_000) {
        // @fitness-ignore-next-line result-pattern-consistency -- infrastructure boundary guard, not domain logic
        throw new ValidationError(
          `File too large (${fileStats.size} bytes, max 10MB): ${filePath}`,
          { code: 'VALIDATION.FITNESS.FILE_TOO_LARGE' },
        );
      }
      content = await fs.readFile(filePath, 'utf8');
    }
    // Dispatch through the LanguageAdapter for the file's extension.
    // See languages/content-filter-dispatch.ts.
    content = applyContentFilter(filePath, content, this.contentFilterMode ?? 'none');
    this.cache.set(filePath, content);
    return content;
  }

  async readMany(filePaths: readonly string[]): Promise<Map<string, string>> {
    // in-memory: single-threaded Node.js access pattern
    const results = new Map<string, string>();
    // @fitness-ignore-next-line no-unbounded-concurrency -- bounded by FileAccessor path set; LRU cache limits memory
    const entries = await Promise.all(
      filePaths.map(async (filePath) => {
        const content = await this.read(filePath);
        return [filePath, content] as const;
      }),
    );
    for (const [filePath, content] of entries) {
      results.set(filePath, content);
    }
    return results;
  }

  async readAll(): Promise<Map<string, string>> {
    return this.readMany(this.paths);
  }

  /** Number of files currently held in the LRU cache. */
  get cachedCount(): number {
    return this.cache.size;
  }

  /** Evict all entries from the file cache. */
  clearCache(): void {
    this.cache.clear();
  }
}

/** Create a FileAccessor for lazy-loading files with LRU caching. */
// @fitness-ignore-next-line result-pattern-consistency -- factory function, cannot fail in domain-meaningful ways
export function createFileAccessor(
  filePaths: readonly string[],
  options: FileAccessorOptions = {},
): FileAccessor {
  return new FileAccessorImpl(filePaths, options);
}
