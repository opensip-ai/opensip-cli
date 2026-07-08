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
  /**
   * Maximum concurrent disk/cache reads for readMany/readAll. Defaults to a
   * bounded value so repository-wide analyzeAll checks do not fan out one
   * promise per matched file.
   */
  readonly readConcurrency?: number;
}

const DEFAULT_CACHE_CAPACITY = 100;
const DEFAULT_READ_CONCURRENCY = 32;

/** FileAccessor implementation with LRU caching and abort signal support. */
class FileAccessorImpl implements FileAccessor {
  readonly paths: readonly string[];
  private readonly cache: LRUCache<string, string>;
  private readonly pathSet: Set<string>;
  private readonly signal?: AbortSignal;
  private readonly contentFilterMode?: FileAccessorOptions['contentFilter'];
  /** Per-run scope cache; undefined on the no-scope direct path (→ disk read). */
  private readonly fileCache?: FileCache;
  private readonly readConcurrency: number;

  constructor(filePaths: readonly string[], options: FileAccessorOptions = {}) {
    this.paths = filePaths;
    this.pathSet = new Set(filePaths);
    this.cache = new LRUCache(options.cacheCapacity ?? DEFAULT_CACHE_CAPACITY);
    this.signal = options.signal;
    this.contentFilterMode = options.contentFilter;
    this.fileCache = options.fileCache;
    this.readConcurrency = normalizeReadConcurrency(options.readConcurrency);
  }

  async read(filePath: string): Promise<string> {
    // in-memory: single-threaded Node.js access pattern
    this.signal?.throwIfAborted();

    if (!this.pathSet.has(filePath)) {
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
    const entries = await mapWithConcurrency(filePaths, this.readConcurrency, async (filePath) => {
      const content = await this.read(filePath);
      return [filePath, content] as const;
    });

    const results = new Map<string, string>();
    for (const entry of entries) {
      const [filePath, content] = entry;
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
export function createFileAccessor(
  filePaths: readonly string[],
  options: FileAccessorOptions = {},
): FileAccessor {
  return new FileAccessorImpl(filePaths, options);
}

function normalizeReadConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_READ_CONCURRENCY;
  if (!Number.isFinite(value)) return DEFAULT_READ_CONCURRENCY;
  return Math.max(1, Math.floor(value));
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: ({ readonly value: R } | undefined)[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex++;
      if (index >= items.length) return;
      results[index] = { value: await fn(items[index], index) };
    }
  });

  await Promise.all(workers);
  const ordered: R[] = [];
  for (let index = 0; index < items.length; index++) {
    const entry = results[index];
    if (entry === undefined) throw new Error('mapWithConcurrency worker did not fill result slot');
    ordered.push(entry.value);
  }
  return ordered;
}
