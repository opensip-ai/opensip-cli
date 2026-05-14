// @fitness-ignore-file concurrency-safety -- single-threaded execution context
// @fitness-ignore-file error-handling-suite -- catch blocks delegate errors through established patterns
/**
 * @fileoverview Execution context creation for fitness checks
 *
 * Provides the runtime context available to check execute functions,
 * including file access, pattern matching, and abort support.
 */

import * as fs from 'node:fs/promises'
import { relative } from 'node:path'

import { Minimatch } from 'minimatch'

import { SystemError } from '@opensip-tools/core'

import type { ResolvedScope } from './check-config.js'
import { DEFAULT_EXCLUSION_PATTERNS } from './constants.js'
import { fileCache } from './file-cache.js'
import { PathMatcher } from './path-matcher.js'
import { extractSnippet } from './result-builder.js'

/**
 * Check identifier (UUID format).
 */
export type CheckId = string

/**
 * Error thrown when a check is aborted via AbortSignal.
 */
export class CheckAbortedError extends SystemError {
  readonly name = 'CheckAbortedError' as const
  readonly checkId: string

  constructor(checkId: string, message?: string) {
    super(message ?? `Check ${checkId} was aborted`, { code: 'SYSTEM.FITNESS.CHECK_ABORTED' })
    this.checkId = checkId
    Object.setPrototypeOf(this, CheckAbortedError.prototype)
  }
}

/**
 * Result of extracting a code snippet.
 */
export interface ExtractSnippetResult {
  readonly snippet: string
  readonly contextLines: number
}

/**
 * Execution context provided to check execute function.
 */
export interface ExecutionContext {
  /** Repository root directory */
  readonly cwd: string
  /** Read a file's contents */
  readonly readFile: (path: string) => Promise<string>
  /** Check if file exists */
  readonly fileExists: (path: string) => Promise<boolean>
  /** The check's stable ID (UUID) */
  readonly checkId: CheckId
  /** The check's human-readable slug (kebab-case) */
  readonly checkSlug: string
  /** Match files using the check's scope or custom patterns */
  readonly matchFiles: (
    patterns?: readonly string[],
    options?: { ignore?: readonly string[] },
  ) => Promise<readonly string[]>
  /** Get a PathMatcher for the check's scope */
  readonly getMatcher: () => PathMatcher
  /** Verbose logging enabled */
  readonly verbose: boolean
  /** Log a message (only in verbose mode) */
  readonly log: (message: string) => void
  /** Extract a code snippet with context lines */
  readonly extractSnippet: (
    content: string,
    line: number,
    contextLines?: number,
  ) => ExtractSnippetResult
  /** AbortSignal for cancellation support */
  readonly signal?: AbortSignal
  /** Throws if the check has been aborted */
  readonly checkAborted: () => void
}

/**
 * Options for running a check.
 */
export interface RunOptions {
  readonly verbose?: boolean
  readonly scopeOverride?: string | ResolvedScope
  readonly additionalExcludes?: readonly string[]
  readonly signal?: AbortSignal
  /** Pre-resolved file paths from per-check target overrides. When set, matchFiles() returns these instead of cache paths. */
  readonly targetFiles?: readonly string[]
  /**
   * Run-wide file exclusion patterns from the project config's
   * `globalExcludes`. Applied to the fileCache fallback path used by
   * scope-empty checks (e.g. `file-length-limit`). Without this filter,
   * a check that declares `scope: { languages: [], concerns: [] }`
   * would scan every prewarmed file regardless of whether the project
   * told us to exclude it — surfacing findings inside `docs/`,
   * `tests/fixtures/`, etc., contrary to user intent.
   */
  readonly globalExcludes?: readonly string[]
}

/**
 * Configuration needed to create execution context.
 */
export interface ExecutionContextConfig {
  readonly id: CheckId
  readonly slug: string
  readonly itemType: string
  readonly unit?: string | undefined
}

/**
 * Creates the matchFiles function for the execution context.
 *
 * `globalExcludes` come from the project config's top-level
 * `globalExcludes` array. They are applied ONLY to the fileCache
 * fallback path — the path taken by scope-empty checks. Custom
 * `patterns` arguments are honored as-is (the caller knows what they
 * want), and `targetFiles` from per-check overrides are pre-filtered
 * by `preResolveAllTargets`. Pre-compiled to Minimatch matchers so
 * we don't pay regex compilation per filter call.
 */
function createMatchFilesFunction(
  cwd: string,
  matcher: PathMatcher,
  targetFiles?: readonly string[],
  globalExcludes?: readonly string[],
): (
  patterns?: readonly string[],
  options?: { ignore?: readonly string[] },
) => Promise<readonly string[]> {
  const compiledGlobalExcludes = globalExcludes && globalExcludes.length > 0
    ? globalExcludes.map((pattern) => new Minimatch(pattern, { dot: true }))
    : undefined

  const applyGlobalExcludes = (files: readonly string[]): readonly string[] => {
    if (!compiledGlobalExcludes) return files
    return files.filter((filePath) => {
      const rel = relative(cwd, filePath)
      return !compiledGlobalExcludes.some((m) => m.match(rel))
    })
  }

  return async (
    patterns?: readonly string[],
    options?: { ignore?: readonly string[] },
  ): Promise<readonly string[]> => {
    if (patterns && patterns.length > 0) {
      const customMatcher = PathMatcher.create({
        cwd,
        include: [...patterns],
        exclude: [...(options?.ignore ?? []), ...DEFAULT_EXCLUSION_PATTERNS],
      })
      return customMatcher.files()
    }

    // Per-check target files take priority over cache.
    // These are already filtered by globalExcludes during target
    // pre-resolution (scope-resolver.ts), so don't re-filter.
    if (targetFiles) {
      return targetFiles
    }

    // When the matcher has no include patterns (checks without targets),
    // fall back to the prewarmed file cache paths. The cache itself
    // honors no exclusion config — that's the layer where globalExcludes
    // must be applied, otherwise scope-empty checks scan every prewarmed
    // file regardless of project intent.
    if (matcher.includePatterns.length === 0) {
      return applyGlobalExcludes(fileCache.paths())
    }

    return matcher.files()
  }
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
  return {
    cwd,
    checkId: config.id,
    checkSlug: config.slug,
    verbose: options?.verbose ?? false,

    // @fitness-ignore-next-line unbounded-memory -- size validation via fs.stat() is on the next line; false positive on method name
    /** @throws {SystemError} When the file exceeds 10MB */
    async readFile(filePath: string): Promise<string> {
      const fileStats = await fs.stat(filePath)
      if (fileStats.size > 10_000_000) {
        throw new SystemError(`File too large (${fileStats.size} bytes, max 10MB): ${filePath}`, { code: 'SYSTEM.FITNESS.FILE_TOO_LARGE' })
      }
      return fileCache.get(filePath)
    },

    fileExists(filePath: string): Promise<boolean> {
      return fileCache.exists(filePath)
    },

    matchFiles: createMatchFilesFunction(cwd, matcher, options?.targetFiles, options?.globalExcludes),

    getMatcher(): PathMatcher {
      return matcher
    },

    log(message: string): void {
      if (options?.verbose) {
        // @fitness-ignore-next-line no-console-log -- Verbose check-level debug output bypasses structured logger for immediate CLI feedback
        // @fitness-ignore-next-line logging-standards -- Verbose check-level debug output bypasses structured logger for immediate CLI feedback
        // eslint-disable-next-line no-console -- Verbose check-level debug output bypasses structured logger for immediate CLI feedback
        console.log(`[${config.slug}] ${message}`)
      }
    },

    extractSnippet(
      content: string,
      line: number,
      contextLines: number = 2,
    ): ExtractSnippetResult {
      return extractSnippet(content, line, contextLines)
    },

    ...(options?.signal ? { signal: options.signal } : {}),

    /** @throws {CheckAbortedError} When the check has been aborted */
    checkAborted(): void {
      if (options?.signal?.aborted) {
        throw new CheckAbortedError(config.slug)
      }
    },
  }
}
