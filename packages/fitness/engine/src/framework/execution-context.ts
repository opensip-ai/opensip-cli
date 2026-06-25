// @fitness-ignore-file error-handling-suite -- catch blocks delegate errors through established patterns
/**
 * @fileoverview Execution context creation for fitness checks
 *
 * Provides the runtime context available to check execute functions,
 * including file access, pattern matching, and abort support.
 */

import * as fs from 'node:fs/promises';

import { SystemError, currentLogger, currentScope } from '@opensip-cli/core';

import { applyGlobalExcludes } from '../targets/index.js';

import { DEFAULT_EXCLUSION_PATTERNS } from './constants.js';
import { PathMatcher } from './path-matcher.js';
import { extractSnippet } from './result-builder.js';

import type { ResolvedScope } from './check-config.js';
import type { FileCache } from './file-cache.js';

/**
 * Check identifier (UUID format).
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- semantic alias for UUID-shaped check identifier
type CheckId = string;

/**
 * Error thrown when a check is aborted via AbortSignal.
 */
export class CheckAbortedError extends SystemError {
  readonly name = 'CheckAbortedError' as const;
  readonly checkId: string;

  constructor(checkId: string, message?: string) {
    super(message ?? `Check ${checkId} was aborted`, { code: 'SYSTEM.FITNESS.CHECK_ABORTED' });
    this.checkId = checkId;
    Object.setPrototypeOf(this, CheckAbortedError.prototype);
  }
}

/**
 * Result of extracting a code snippet.
 */
interface ExtractSnippetResult {
  readonly snippet: string;
  readonly contextLines: number;
}

/**
 * Execution context provided to check execute function.
 */
export interface ExecutionContext {
  /** Repository root directory */
  readonly cwd: string;
  /** Read a file's contents */
  readonly readFile: (path: string) => Promise<string>;
  /** Check if file exists */
  readonly fileExists: (path: string) => Promise<boolean>;
  /** The check's stable ID (UUID) */
  readonly checkId: CheckId;
  /** The check's human-readable slug (kebab-case) */
  readonly checkSlug: string;
  /** Match files using the check's scope or custom patterns */
  readonly matchFiles: (
    patterns?: readonly string[],
    options?: { ignore?: readonly string[] },
  ) => Promise<readonly string[]>;
  /** Get a PathMatcher for the check's scope */
  readonly getMatcher: () => PathMatcher;
  /** Verbose logging enabled */
  readonly verbose: boolean;
  /** Log a message (only in verbose mode) */
  readonly log: (message: string) => void;
  /** Extract a code snippet with context lines */
  readonly extractSnippet: (
    content: string,
    line: number,
    contextLines?: number,
  ) => ExtractSnippetResult;
  /** AbortSignal for cancellation support */
  readonly signal?: AbortSignal;
  /** Throws if the check has been aborted */
  readonly checkAborted: () => void;
}

/**
 * Options for running a check.
 */
export interface RunOptions {
  readonly verbose?: boolean;
  readonly scopeOverride?: string | ResolvedScope;
  readonly additionalExcludes?: readonly string[];
  readonly signal?: AbortSignal;
  /** Pre-resolved file paths from per-check target overrides. When set, matchFiles() returns these instead of cache paths. */
  readonly targetFiles?: readonly string[];
  /**
   * Run-wide file exclusion patterns from the project config's
   * `globalExcludes`. Applied to the fileCache fallback path used by
   * scope-empty checks (e.g. `file-length-limit`). Without this filter,
   * a check that declares `scope: { languages: [], concerns: [] }`
   * would scan every prewarmed file regardless of whether the project
   * told us to exclude it — surfacing findings inside `docs/`,
   * `tests/fixtures/`, etc., contrary to user intent.
   */
  readonly globalExcludes?: readonly string[];
  /**
   * Per-run FileCache instance. On the production path the recipe service passes
   * the resolved `scope.fitness.fileCache` here. Optional only for the no-scope
   * direct `run()` / unit-test path; when omitted, `createExecutionContext`
   * resolves `currentScope()?.fitness?.fileCache` and throws
   * `SYSTEM.FITNESS.NO_FILE_CACHE` if neither is present on a file-reading path
   * (no module-singleton fallback — parallel-tool-invocations Phase 1).
   */
  readonly fileCache?: FileCache;
}

/**
 * Configuration needed to create execution context.
 */
export interface ExecutionContextConfig {
  readonly id: CheckId;
  readonly slug: string;
  readonly itemType: string;
  readonly unit?: string | undefined;
}

/**
 * Creates the matchFiles function for the execution context.
 *
 * `globalExcludes` come from the project config's top-level
 * `globalExcludes` array. They are applied ONLY to the fileCache
 * fallback path — the path taken by scope-empty checks. Custom
 * `patterns` arguments are honored as-is (the caller knows what they
 * want), and `targetFiles` from per-check overrides are pre-filtered
 * by `preResolveAllTargets`. The fileCache-fallback exclusion routes
 * through the substrate `applyGlobalExcludes` (ADR-0037) — the SAME
 * single implementation the scope-resolution path uses, so globalExcludes
 * is single-sourced on both paths (no separate Minimatch path in fitness).
 *
 * `fc` is the per-run cache resolved by {@link createExecutionContext}
 * (`options.fileCache ?? currentScope().fitness.fileCache`) — REQUIRED, no
 * module-singleton fallback (parallel-tool-invocations Phase 1).
 */
function createMatchFilesFunction(
  cwd: string,
  matcher: PathMatcher,
  fc: FileCache,
  targetFiles?: readonly string[],
  globalExcludes?: readonly string[],
): (
  patterns?: readonly string[],
  options?: { ignore?: readonly string[] },
) => Promise<readonly string[]> {
  return async (
    patterns?: readonly string[],
    options?: { ignore?: readonly string[] },
  ): Promise<readonly string[]> => {
    if (patterns && patterns.length > 0) {
      const customMatcher = PathMatcher.create({
        cwd,
        include: [...patterns],
        exclude: [...(options?.ignore ?? []), ...DEFAULT_EXCLUSION_PATTERNS],
      });
      return customMatcher.files();
    }

    // Per-check target files take priority over cache.
    // These are already filtered by globalExcludes during target
    // pre-resolution (scope-resolver.ts), so don't re-filter.
    if (targetFiles) {
      return targetFiles;
    }

    // When the matcher has no include patterns (checks without targets),
    // fall back to the prewarmed file cache paths. The cache itself
    // honors no exclusion config — that's the layer where globalExcludes
    // must be applied, otherwise scope-empty checks scan every prewarmed
    // file regardless of project intent.
    if (matcher.includePatterns.length === 0) {
      return applyGlobalExcludes(fc.paths(), cwd, globalExcludes ?? []);
    }

    return matcher.files();
  };
}

/**
 * Creates the execution context for a check.
 */
export function createExecutionContext(
  config: ExecutionContextConfig,
  cwd: string,
  matcher: PathMatcher,
  options?: RunOptions,
): ExecutionContext {
  // Resolve the per-run cache: the explicit option (recipe service passes
  // `execOpts.fileCache` on the production path) or the entered scope's
  // canonical `scope.fitness.fileCache`. No module-singleton fallback — a
  // file-reading production path MUST run inside a scope carrying the fitness
  // subscope (parallel-tool-invocations Phase 1). The no-scope direct `run()`
  // path may pass `options.fileCache` explicitly; absent both, file reads throw.
  const fc = options?.fileCache ?? currentScope()?.fitness?.fileCache;
  if (!fc) {
    throw new SystemError(
      `No per-run FileCache available for check '${config.slug}'. A file-reading ` +
        `check must run inside a RunScope carrying scope.fitness.fileCache (the CLI ` +
        `pre-action-hook installs it via the fitness tool's contributeScope), or be ` +
        `passed an explicit options.fileCache.`,
      { code: 'SYSTEM.FITNESS.NO_FILE_CACHE' },
    );
  }
  return {
    cwd,
    checkId: config.id,
    checkSlug: config.slug,
    verbose: options?.verbose ?? false,

    /** @throws {SystemError} When the file exceeds 10MB */
    async readFile(filePath: string): Promise<string> {
      // Fast-fail on obvious on-disk size before pulling content (optimization).
      // The authoritative check is performed on the *actual* bytes returned
      // (closes TOCTOU between stat and read, and protects against a cache
      // entry that grew or was prewarmed with a larger version).
      try {
        const fileStats = await fs.stat(filePath);
        if (fileStats.size > 10_000_000) {
          throw new SystemError(`File too large (${fileStats.size} bytes, max 10MB): ${filePath}`, {
            code: 'SYSTEM.FITNESS.FILE_TOO_LARGE',
          });
        }
      } catch (error) {
        // If stat itself fails, let the subsequent get() surface the real FS error
        // (directory, permission, etc.). Only swallow the size error we just threw.
        if (error instanceof SystemError && error.code === 'SYSTEM.FITNESS.FILE_TOO_LARGE')
          throw error;
      }

      const content = await fc.get(filePath);
      if (content.length > 10_000_000) {
        throw new SystemError(`File too large (${content.length} bytes, max 10MB): ${filePath}`, {
          code: 'SYSTEM.FITNESS.FILE_TOO_LARGE',
        });
      }
      return content;
    },

    fileExists(filePath: string): Promise<boolean> {
      return fc.exists(filePath);
    },

    matchFiles: createMatchFilesFunction(
      cwd,
      matcher,
      fc,
      options?.targetFiles,
      options?.globalExcludes,
    ),

    getMatcher(): PathMatcher {
      return matcher;
    },

    log(message: string): void {
      if (!options?.verbose) return;
      // Route through the structured logger from RunScope so future
      // --json / --quiet modes that reconfigure the logger can suppress
      // check-level debug output uniformly. Falls back to the module
      // default logger when no scope is active (e.g. test harnesses
      // that exercise an ExecutionContext directly). Audit-round-2
      // Finding D: this was previously `console.log` which bypassed
      // the structured channel and could not be suppressed.
      const log = currentLogger();
      log.info({
        evt: 'fitness.check.verbose',
        module: 'fitness:framework',
        checkSlug: config.slug,
        message,
      });
    },

    extractSnippet(content: string, line: number, contextLines = 2): ExtractSnippetResult {
      return extractSnippet(content, line, contextLines);
    },

    ...(options?.signal ? { signal: options.signal } : {}),

    /** @throws {CheckAbortedError} When the check has been aborted */
    checkAborted(): void {
      if (options?.signal?.aborted) {
        throw new CheckAbortedError(config.slug);
      }
    },
  };
}
