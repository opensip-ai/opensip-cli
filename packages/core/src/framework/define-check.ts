// @fitness-ignore-file module-coupling-metrics -- central orchestration module with necessary coupling
// @fitness-ignore-file null-safety -- ResultBuilder.create() returns a fluent builder; .totalItems().filesScanned() chain is always safe
/**
 * @fileoverview defineCheck - Unified check definition API
 *
 * The main API for creating fitness checks. Supports three modes:
 * - analyze: Per-file analysis with content and path
 * - analyzeAll: Multi-file analysis with lazy loading FileAccessor
 * - command: External tool execution with output parsing
 *
 * Check authors return CheckViolation[]. The framework converts each
 * CheckViolation into a universal Signal via createSignal().
 */

import { logger } from '../lib/logger.js'
import { SystemError } from '../lib/errors.js'
import type { Signal } from '../types/signal.js'
import { createSignal } from '../types/signal.js'

import type { CheckResult } from '../types/findings.js'

import type {
  UnifiedCheckConfig,
  CheckViolation,
  AnalyzeCheckConfig,
  AnalyzeAllCheckConfig,
  CommandCheckConfig,
} from './check-config.js'
import {
  getAnalysisMode,
  isAnalyzeConfig,
  isAnalyzeAllConfig,
  isCommandConfig,
  validateCheckConfig,
} from './check-config.js'
import type { Check } from './check-types.js'
import { executeCommand } from './command-executor.js'
import { filterContent } from './content-filter.js'
import type { ExecutionContext, RunOptions } from './execution-context.js'
import { CheckAbortedError, createExecutionContext } from './execution-context.js'
import { createFileAccessor } from './file-accessor.js'
import { filterFilesByType } from './file-type-filter.js'
import { filterSignalsByDirectives, buildFilteredResult } from './ignore-processing.js'
import { PathMatcher } from './path-matcher.js'
import { ResultBuilder } from './result-builder.js'
import { mapFindingSeverity, mapTagsToSignalCategory } from './severity-mapping.js'

// =============================================================================
// VIOLATION → SIGNAL CONVERSION
// =============================================================================

function toSignal(
  violation: CheckViolation,
  checkSlug: string,
  checkTags: readonly string[],
  defaultFilePath?: string,
  provider: string = 'opensip',
): Signal {
  const filePath = violation.filePath ?? defaultFilePath ?? ''
  return createSignal({
    source: 'fitness',
    provider,
    severity: mapFindingSeverity(violation.severity),
    category: mapTagsToSignalCategory(checkTags),
    ruleId: `fit:${checkSlug}`,
    message: violation.message,
    suggestion: violation.suggestion,
    code: { file: filePath, line: violation.line, column: violation.column },
    fix: violation.fix
      ?? (violation.suggestion ? { action: 'refactor' as const, confidence: 0.5 } : undefined),
    metadata: Object.fromEntries(
      Object.entries({
        match: violation.match,
        type: violation.type,
        checkSlug,
        checkTags: checkTags.length > 0 ? checkTags.join(',') : undefined,
      }).filter(([, v]) => v != null && v !== ''),
    ),
  })
}

// =============================================================================
// ANALYSIS MODE EXECUTORS
// =============================================================================

/** @throws {CheckAbortedError} When the check is aborted via AbortSignal */
async function executeAnalyzeMode(
  config: AnalyzeCheckConfig,
  files: readonly string[],
  ctx: ExecutionContext,
): Promise<CheckResult> {
  const builder = ResultBuilder.create({
    checkId: config.id,
    itemType: config.itemType ?? 'files',
  })
    .totalItems(files.length)
    .filesScanned(files.length)

  for (const filePath of files) {
    if (ctx.signal?.aborted) {
      throw new CheckAbortedError(config.slug)
    }

    try {
      const rawContent = await ctx.readFile(filePath)
      let content: string
      // Two distinct filter modes — pick based on what the rule scans:
      //   `code-only`            → string literals blanked, COMMENTS PRESERVED.
      //                            Use when the rule reads comment-based
      //                            directives (e.g. `// @swallow-ok`,
      //                            `// @fitness-ignore-next-line`) or other
      //                            JSDoc/prose markers.
      //   `no-strings-no-comments` → both blanked. Use when the rule's
      //                            pattern would false-fire on the same
      //                            phrase appearing in a comment.
      // Don't conflate the two — rule authors choose deliberately.
      if (config.contentFilter === 'code-only') {
        content = filterContent(rawContent).code
      } else if (config.contentFilter === 'no-strings-no-comments') {
        content = filterContent(rawContent).codeNoComments
      } else {
        content = rawContent
      }
      const violations = config.analyze(content, filePath)

      for (const violation of violations) {
        void builder.addSignal(toSignal(violation, config.slug, config.tags ?? [], filePath, config.provider))
      }
    } catch (err) {
      if (err instanceof CheckAbortedError) throw err
      logger.debug('Skipping unreadable file', { evt: 'fitness.check.file.skip', module: 'fitness:framework', filePath, checkSlug: config.slug })
    }
  }

  return builder.build()
}

/** @throws {CheckAbortedError} When the check is aborted via AbortSignal */
async function executeAnalyzeAllMode(
  config: AnalyzeAllCheckConfig,
  files: readonly string[],
  ctx: ExecutionContext,
): Promise<CheckResult> {
  if (ctx.signal?.aborted) {
    throw new CheckAbortedError(config.slug)
  }

  const fileAccessor = createFileAccessor(files, { signal: ctx.signal, contentFilter: config.contentFilter })
  const violations = await config.analyzeAll(fileAccessor)

  if (ctx.signal?.aborted) {
    throw new CheckAbortedError(config.slug)
  }

  const builder = ResultBuilder.create({
    checkId: config.id,
    itemType: config.itemType ?? 'files',
  })
    .totalItems(files.length)
    .filesScanned(files.length)

  for (const violation of violations) {
    if (!violation.filePath) {
      ctx.log(`Warning: violation missing filePath in analyzeAll mode`)
    }
    void builder.addSignal(toSignal(violation, config.slug, config.tags ?? [], undefined, config.provider))
  }

  return builder.build()
}

/** @throws {CheckAbortedError} When the check is aborted via AbortSignal */
async function executeCommandMode(
  config: CommandCheckConfig,
  files: readonly string[],
  ctx: ExecutionContext,
): Promise<CheckResult> {
  const result = await executeCommand(config.command, files, {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: config.timeout,
  })

  if (result.aborted) {
    throw new CheckAbortedError(config.slug)
  }

  const builder = ResultBuilder.create({
    checkId: config.id,
    itemType: config.itemType ?? 'files',
  })
    .totalItems(files.length)
    .filesScanned(0)

  if (result.error) {
    return builder.buildError(result.error)
  }

  for (const violation of result.violations) {
    void builder.addSignal(toSignal(violation, config.slug, config.tags ?? [], undefined, config.provider))
  }

  return builder.build()
}

// =============================================================================
// MAIN EXPORT
// =============================================================================

/**
 * Define a fitness check using the unified API.
 *
 * @example
 * ```typescript
 * export const noConsoleLog = defineCheck({
 *   id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
 *   slug: 'no-console-log',
 *   category: 'quality',
 *   description: 'Disallow console.log in production code',
 *   analyze: (content, filePath) => {
 *     const violations: CheckViolation[] = [];
 *     content.split('\n').forEach((line, idx) => {
 *       if (line.includes('console.log')) {
 *         violations.push({ line: idx + 1, message: 'No console.log', severity: 'error' });
 *       }
 *     });
 *     return violations;
 *   },
 * });
 * ```
 * @throws {ValidationError} When the check config is invalid
 */
export function defineCheck(config: UnifiedCheckConfig): Check {
  validateCheckConfig(config)

  const check: Check = {
    config: {
      id: config.id,
      slug: config.slug,
      tags: config.tags ? [...config.tags] : [],
      description: config.description,
      longDescription: config.longDescription,
      analysisMode: getAnalysisMode(config),
      scope: { include: [], exclude: [], description: '' },
      itemType: config.itemType ?? 'files',
      docs: config.docs,
      disabled: config.disabled,
      confidence: config.confidence,
      timeout: config.timeout,
      scansFiles: !isCommandConfig(config),
      fileTypes: config.fileTypes ? [...config.fileTypes] : undefined,
      checkScope: config.scope ? { languages: [...config.scope.languages], concerns: [...config.scope.concerns] } : undefined,
      // @fitness-ignore-next-line concurrency-safety -- async arrow delegates to executeCheckV2 which is async; needed for type compatibility
      execute: async (ctx) => executeCheckV2(config, ctx),
    },

    getScope() {
      return { include: [], exclude: [], description: 'v2 target-based scope' }
    },

    getMatcher(cwd: string): PathMatcher {
      return PathMatcher.create({
        include: [],
        exclude: [],
        cwd,
      })
    },

    async run(cwd: string, options?: RunOptions): Promise<CheckResult> {
      const start = Date.now()

      const matcher = PathMatcher.create({
        include: [],
        exclude: [],
        cwd,
      })

      const legacyConfig = {
        id: config.id,
        slug: config.slug,
        tags: config.tags ? [...config.tags] : [],
        description: config.description,
        scope: { include: [] as readonly string[], exclude: [] as readonly string[], description: '' },
        itemType: (config.itemType ?? 'files') as import('../types/findings.js').ItemType,
        docs: config.docs,
        disabled: config.disabled,
        timeout: config.timeout,
        scansFiles: !isCommandConfig(config),
        // @fitness-ignore-next-line concurrency-safety -- async arrow delegates to executeCheckV2 which is async; needed for type compatibility
        execute: async (ctx: ExecutionContext) => executeCheckV2(config, ctx),
      }

      const ctx = createExecutionContext(legacyConfig, cwd, matcher, options)

      try {
        const result = await executeCheckV2(config, ctx)

        const { filteredSignals, ignoredCount, appliedDirectives } = await filterSignalsByDirectives(
          result.signals,
          config.slug,
          result.ignoredCount ?? 0,
        )

        const filtered = buildFilteredResult(result, filteredSignals, ignoredCount, start)
        return appliedDirectives.length > 0 ? { ...filtered, appliedDirectives } : filtered
      } catch (error) {
        if (error instanceof CheckAbortedError) throw error

        const builder = ResultBuilder.create({
          checkId: config.id,
          itemType: config.itemType ?? 'files',
        })
        return builder.buildError(
          `Check ${config.slug} threw an error: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined,
        )
      }
    },
  }

  return check
}

/**
 * Internal: Execute a v2 check based on its analysis mode.
 * @throws {CheckAbortedError} When the check is aborted via AbortSignal
 * @throws {SystemError} When an unknown analysis mode is encountered
 */
async function executeCheckV2(
  config: UnifiedCheckConfig,
  ctx: ExecutionContext,
): Promise<CheckResult> {
  const matchedFiles = await ctx.matchFiles()

  // Filter by check's declared file types
  const files = filterFilesByType(matchedFiles, config.fileTypes)

  ctx.log(`Matched ${files.length} files`)

  if (isAnalyzeConfig(config)) {
    return executeAnalyzeMode(config, files, ctx)
  } else if (isAnalyzeAllConfig(config)) {
    return executeAnalyzeAllMode(config, files, ctx)
  } else if (isCommandConfig(config)) {
    return executeCommandMode(config, files, ctx)
  }

  const _exhaustiveCheck: never = config
  throw new SystemError(`Unknown analysis mode: ${JSON.stringify(_exhaustiveCheck)}`, { code: 'SYSTEM.FITNESS.UNKNOWN_MODE' })
}
