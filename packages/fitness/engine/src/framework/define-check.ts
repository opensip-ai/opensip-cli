// @fitness-ignore-file module-coupling-metrics -- central orchestration module with necessary coupling
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

import {
  logger,
  SystemError,
  createSignal,
  applyContentFilter,
  currentScope,
} from '@opensip-cli/core';

import {
  getAnalysisMode,
  isAnalyzeConfig,
  isAnalyzeAllConfig,
  isCommandConfig,
  validateCheckConfig,
} from './check-config.js';
import { executeCommand } from './command-executor.js';
import { CheckAbortedError, createExecutionContext } from './execution-context.js';
import { createFileAccessor } from './file-accessor.js';
import { filterFilesByType } from './file-type-filter.js';
import { filterSignalsByDirectives, buildFilteredResult } from './ignore-processing.js';
import { PathMatcher } from './path-matcher.js';
import { ResultBuilder } from './result-builder.js';
import { mapFindingSeverity, mapTagsToSignalCategory } from './severity-mapping.js';

import type {
  UnifiedCheckConfig,
  CheckViolation,
  AnalyzeCheckConfig,
  AnalyzeAllCheckConfig,
  CommandCheckConfig,
} from './check-config.js';
import type { Check } from './check-types.js';
import type { ExecutionContext, RunOptions } from './execution-context.js';
import type { CheckResult } from '../types/findings.js';
import type { Signal } from '@opensip-cli/core';

// =============================================================================
// VIOLATION → SIGNAL CONVERSION
// =============================================================================

function toSignal(
  violation: CheckViolation,
  checkSlug: string,
  checkTags: readonly string[],
  defaultFilePath?: string,
  provider = 'opensip',
): Signal {
  const filePath = violation.filePath ?? defaultFilePath ?? '';
  return createSignal({
    source: 'fitness',
    provider,
    severity: mapFindingSeverity(violation.severity),
    category: mapTagsToSignalCategory(checkTags),
    ruleId: `fit:${checkSlug}`,
    message: violation.message,
    suggestion: violation.suggestion,
    code: { file: filePath, line: violation.line, column: violation.column },
    fix:
      violation.fix ??
      (violation.suggestion ? { action: 'refactor' as const, confidence: 0.5 } : undefined),
    metadata: Object.fromEntries(
      Object.entries({
        match: violation.match,
        type: violation.type,
        checkSlug,
        checkTags: checkTags.length > 0 ? checkTags.join(',') : undefined,
      }).filter(([, v]) => v != null && v !== ''),
    ),
  });
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
    .filesScanned(files.length);

  for (const filePath of files) {
    if (ctx.signal?.aborted) {
      throw new CheckAbortedError(config.slug);
    }

    try {
      const rawContent = await ctx.readFile(filePath);
      // Dispatch the content filter through the LanguageAdapter for the
      // file's extension. Falls back to raw content when no adapter is
      // registered. See languages/content-filter-dispatch.ts.
      const content = applyContentFilter(filePath, rawContent, config.contentFilter ?? 'none');
      const violations = config.analyze(content, filePath);

      for (const violation of violations) {
        void builder.addSignal(
          toSignal(violation, config.slug, config.tags ?? [], filePath, config.provider),
        );
      }
    } catch (error) {
      if (error instanceof CheckAbortedError) throw error;
      logger.debug('Skipping unreadable file', {
        evt: 'fitness.check.file.skip',
        module: 'fitness:framework',
        filePath,
        checkSlug: config.slug,
      });
    }
  }

  return builder.build();
}

/** @throws {CheckAbortedError} When the check is aborted via AbortSignal */
async function executeAnalyzeAllMode(
  config: AnalyzeAllCheckConfig,
  files: readonly string[],
  ctx: ExecutionContext,
): Promise<CheckResult> {
  if (ctx.signal?.aborted) {
    throw new CheckAbortedError(config.slug);
  }

  // Inject the per-run scope cache so analyzeAll checks read prewarmed content
  // (closing the historical global-cache miss — parallel-tool-invocations Phase 1).
  // `executeAnalyzeAllMode` runs inside the run's scope (the recipe service
  // enters `runWithScope`), so this resolves the same prewarmed instance the
  // ExecutionContext resolved. On the no-scope direct path it is `undefined` and
  // the accessor falls through to disk.
  const fileAccessor = createFileAccessor(files, {
    signal: ctx.signal,
    contentFilter: config.contentFilter,
    ...(currentScope()?.fitness?.fileCache
      ? { fileCache: currentScope()?.fitness?.fileCache }
      : {}),
  });
  const violations = await config.analyzeAll(fileAccessor);

  if (ctx.signal?.aborted) {
    throw new CheckAbortedError(config.slug);
  }

  const builder = ResultBuilder.create({
    checkId: config.id,
    itemType: config.itemType ?? 'files',
  })
    .totalItems(files.length)
    .filesScanned(files.length);

  for (const violation of violations) {
    if (!violation.filePath) {
      ctx.log(`Warning: violation missing filePath in analyzeAll mode`);
    }
    void builder.addSignal(
      toSignal(violation, config.slug, config.tags ?? [], undefined, config.provider),
    );
  }

  return builder.build();
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
  });

  /* v8 ignore start -- defensive: command-mode tests cover the non-aborted path; abort during external command execution requires a long-running subprocess that's intentionally not unit-testable */
  if (result.aborted) {
    throw new CheckAbortedError(config.slug);
  }
  /* v8 ignore stop */

  const builder = ResultBuilder.create({
    checkId: config.id,
    itemType: config.itemType ?? 'files',
  })
    .totalItems(files.length)
    .filesScanned(0);

  if (result.error) {
    return builder.buildError(result.error);
  }

  for (const violation of result.violations) {
    void builder.addSignal(
      toSignal(violation, config.slug, config.tags ?? [], undefined, config.provider),
    );
  }

  return builder.build();
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
  validateCheckConfig(config);

  // Canonicalise scope languages through the current scope's language
  // registry so a check declared with `scope: { languages: ['c'] }` is
  // indexed under the canonical id `'cpp'`. Unknown languages pass
  // through unchanged (with a debug log) — they may resolve later if a
  // custom adapter ships, and dropping them here would silently break
  // checks. When `defineCheck` runs at module-load time before a scope
  // is bound (the typical case for top-level `export const x =
  // defineCheck(...)`), we cannot canonicalise — just lowercase.
  //
  // Recovery: the engine *always* re-canonicalizes check-declared languages
  // at scope-match / file-resolution time (see scope-resolver.ts: liveScopeLangs
  // map + target-registry.ts:toCanonical + findByScope). This makes define-time
  // canonicalization best-effort only; execution-time canonicalization against
  // the entered RunScope's LanguageRegistry is the source of truth for matching.
  const scope = currentScope();
  const canonicalLanguages = config.scope
    ? config.scope.languages.map((lang) => {
        const canonical = scope?.languages.canonicalize(lang);
        if (canonical === undefined) {
          logger.debug({
            evt: 'fitness.check.scope.unknown_language',
            module: 'fitness:framework',
            checkSlug: config.slug,
            language: lang,
            msg: `Check ${config.slug} declared scope language ${lang} which is not registered (or no scope at definition time)`,
          });
          return lang.toLowerCase();
        }
        return canonical;
      })
    : undefined;

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
      checkScope:
        config.scope && canonicalLanguages
          ? { languages: canonicalLanguages, concerns: [...config.scope.concerns] }
          : undefined,
      // Display metadata travels WITH the check (§5.3 fold) — no separate
      // per-process display sidecar/singleton. Authors set these inline, or a
      // pack's display map is applied via applyCheckDisplay().
      icon: config.icon,
      displayName: config.displayName,
      execute: async (ctx) => executeUnifiedCheck(config, ctx),
    },

    getScope() {
      return { include: [], exclude: [], description: 'target-based scope' };
    },

    getMatcher(cwd: string): PathMatcher {
      return PathMatcher.create({
        include: [],
        exclude: [],
        cwd,
      });
    },

    async run(cwd: string, options?: RunOptions): Promise<CheckResult> {
      const start = Date.now();

      const matcher = PathMatcher.create({
        include: [],
        exclude: [],
        cwd,
      });

      const executionConfig = {
        id: config.id,
        slug: config.slug,
        itemType: config.itemType ?? 'files',
      };

      const ctx = createExecutionContext(executionConfig, cwd, matcher, options);

      try {
        const result = await executeUnifiedCheck(config, ctx);

        const { filteredSignals, ignoredCount, appliedDirectives } =
          await filterSignalsByDirectives(result.signals, config.slug, result.ignoredCount ?? 0);

        const filtered = buildFilteredResult(result, filteredSignals, ignoredCount, start);
        return appliedDirectives.length > 0 ? { ...filtered, appliedDirectives } : filtered;
      } catch (error) {
        if (error instanceof CheckAbortedError) throw error;

        const builder = ResultBuilder.create({
          checkId: config.id,
          itemType: config.itemType ?? 'files',
        });
        return builder.buildError(
          `Check ${config.slug} threw an error: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined,
        );
      }
    },
  };

  return check;
}

/**
 * Internal: Execute a check based on its analysis mode (analyze /
 * analyzeAll / command).
 * @throws {CheckAbortedError} When the check is aborted via AbortSignal
 * @throws {SystemError} When an unknown analysis mode is encountered
 */
async function executeUnifiedCheck(
  config: UnifiedCheckConfig,
  ctx: ExecutionContext,
): Promise<CheckResult> {
  const matchedFiles = await ctx.matchFiles();

  // Filter by check's declared file types
  const files = filterFilesByType(matchedFiles, config.fileTypes);

  ctx.log(`Matched ${files.length} files`);

  if (isAnalyzeConfig(config)) {
    return executeAnalyzeMode(config, files, ctx);
  } else if (isAnalyzeAllConfig(config)) {
    return executeAnalyzeAllMode(config, files, ctx);
  } else if (isCommandConfig(config)) {
    return executeCommandMode(config, files, ctx);
  }

  /* v8 ignore start -- exhaustive check: all UnifiedCheckConfig variants are handled above; this throw fires only if someone introduces a new variant without updating this switch */
  const _exhaustiveCheck: never = config;
  throw new SystemError(`Unknown analysis mode: ${JSON.stringify(_exhaustiveCheck)}`, {
    code: 'SYSTEM.FITNESS.UNKNOWN_MODE',
  });
  /* v8 ignore stop */
}
