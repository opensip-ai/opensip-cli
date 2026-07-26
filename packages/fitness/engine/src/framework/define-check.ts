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

import { fitnessErrorCatalog } from '../errors/fitness-error-catalog.js';

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
import type { Signal, SignalRepair } from '@opensip-cli/core';


// Plan 01 clean break: registered definitions replace bare code literals that only
// resolved through the family fallback.
const ENGINE_STATE = fitnessErrorCatalog.require('SYSTEM.FITNESS.ENGINE_STATE_INVALID');

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
  const fix =
    violation.fix ??
    (violation.suggestion ? { action: 'refactor' as const, confidence: 0.5 } : undefined);
  return createSignal({
    source: 'fitness',
    provider,
    severity: mapFindingSeverity(violation.severity),
    category: mapTagsToSignalCategory(checkTags),
    ruleId: `fit:${checkSlug}`,
    message: violation.message,
    suggestion: violation.suggestion,
    code: { file: filePath, line: violation.line, column: violation.column },
    fix,
    repair: repairFromViolation(violation, filePath),
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

function repairKindForFitnessAction(
  action: NonNullable<CheckViolation['fix']>['action'] | undefined,
): SignalRepair['repairKind'] {
  if (action === 'refactor') return 'extract-module';
  return 'manual';
}

function repairFromViolation(
  violation: CheckViolation,
  filePath: string,
): SignalRepair | undefined {
  if (violation.repair !== undefined) return violation.repair;
  if (violation.fix === undefined && violation.suggestion === undefined) return undefined;
  const action = violation.fix?.action;
  const summary =
    violation.suggestion ??
    (action === undefined ? undefined : `Apply ${action} remediation for this finding`);
  return {
    repairKind: repairKindForFitnessAction(action),
    autofixable:
      violation.fix?.replacement !== undefined &&
      (action === 'replace' || action === 'insert' || action === 'delete'),
    confidence: violation.fix?.confidence ?? 0.5,
    ...(summary === undefined
      ? {}
      : { patchHint: { kind: 'text', summary, ...(filePath === '' ? {} : { target: filePath }) } }),
  };
}

// =============================================================================
// ANALYSIS MODE EXECUTORS
// =============================================================================

/**
 * @throws {CheckAbortedError} When the original error is an abort.
 * @throws {Error} Always rethrows `error` (wrapped via `wrap` when not already an Error).
 */
function rethrowUnlessAbort(error: unknown, wrap: (message: string) => Error): never {
  if (error instanceof CheckAbortedError) throw error;
  throw error instanceof Error ? error : wrap(String(error));
}

async function analyzeSingleFile(
  config: AnalyzeCheckConfig,
  filePath: string,
  ctx: ExecutionContext,
): Promise<readonly CheckViolation[] | 'skip'> {
  let rawContent: string;
  try {
    rawContent = await ctx.readFile(filePath);
  } catch (error) {
    if (error instanceof CheckAbortedError) throw error;

    // FILE_TOO_LARGE is a deliberate, structural skip (files over the 10MB
    // read bound), not a transient fs race — burying it at debug contradicts
    // the fail-loud posture (a >10MB file silently drops out of every
    // analyze-mode check with no visible trace). Surface it at warn, and
    // through the per-run diagnostics bus (the same channel `service.ts`
    // uses for run-lifecycle events) so a `--json` consumer sees it too.
    if (error instanceof SystemError && error.code === 'SYSTEM.FITNESS.FILE_TOO_LARGE') {
      logger.warn('Skipping oversized file', {
        evt: 'fitness.check.file.skip.too_large',
        module: 'fitness:framework',
        filePath,
        checkSlug: config.slug,
        err: error,
      });
      currentScope()?.diagnostics.event(
        'execute',
        'warn',
        `Skipped oversized file for check '${config.slug}': ${filePath}`,
        { checkSlug: config.slug, filePath, reason: 'file-too-large' },
      );
      return 'skip';
    }

    // Genuine filesystem races (ENOENT, permission errors, etc.) stay
    // skippable at debug. Analyze bugs must not silently green-pass the
    // rest of the run.
    logger.debug('Skipping unreadable file', {
      evt: 'fitness.check.file.skip',
      module: 'fitness:framework',
      filePath,
      checkSlug: config.slug,
    });
    return 'skip';
  }

  let content: string;
  try {
    // Dispatch the content filter through the LanguageAdapter for the
    // file's extension. Falls back to raw content when no adapter is
    // registered. See languages/content-filter-dispatch.ts.
    content = applyContentFilter(filePath, rawContent, config.contentFilter ?? 'none');
  } catch (error) {
    rethrowUnlessAbort(
      error,
      (message) => new Error(`Content filter failed for ${filePath}: ${message}`),
    );
  }

  try {
    return config.analyze(content, filePath);
  } catch (error) {
    // Surface analyze-mode throws as check failure (parity with analyzeAll).
    rethrowUnlessAbort(
      error,
      (message) => new Error(`Check analyze failed for ${filePath}: ${message}`),
    );
  }
}

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

  // @sequential-ok — checks analyze one file at a time by design: concurrency-1
  // keeps memory bounded (one file's content resident), preserves deterministic
  // violation ordering, and keeps the abort signal responsive between files.
  for (const filePath of files) {
    if (ctx.signal?.aborted) {
      throw new CheckAbortedError(config.slug);
    }

    const violations = await analyzeSingleFile(config, filePath, ctx);
    if (violations === 'skip') continue;

    for (const violation of violations) {
      void builder.addSignal(
        toSignal(violation, config.slug, config.tags ?? [], filePath, config.provider),
      );
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
  const builder = ResultBuilder.create({
    checkId: config.id,
    itemType: config.itemType ?? 'files',
  })
    .totalItems(files.length)
    .filesScanned(0);

  // File-list-driven scanners (`args: (files) => ...`) with zero matched files
  // must not invoke the binary: tools like clang-tidy exit 1 with
  // "no input files specified", and the green-wash fail-closed path promotes
  // that to a unit fault. Project-wide command checks use `args: () => ...` or
  // a static args array and still run with an empty file list.
  if (
    files.length === 0 &&
    typeof config.command.args === 'function' &&
    config.command.args.length > 0
  ) {
    const clean = builder.build();
    return {
      ...clean,
      info: { label: 'Skipped: no matched files' },
      metadata: {
        ...clean.metadata,
        extra: {
          ...clean.metadata.extra,
          skipped: true,
          skipReason: 'no-matched-files',
          skipMessage: 'no matched files for file-list command check',
        },
      },
    };
  }

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

  if (result.error) {
    // Optional external tools that are not installed are a skip, not a
    // framework fault. Key on the structured notInstalled flag only — never
    // substring-match the free-text error (stderr can mention "is not installed").
    if (result.notInstalled === true) {
      const clean = builder.build();
      return {
        ...clean,
        info: { label: `Skipped: ${result.error}` },
        metadata: {
          ...clean.metadata,
          extra: {
            ...clean.metadata.extra,
            skipped: true,
            skipReason: 'tool-not-installed',
            skipMessage: result.error,
          },
        },
      };
    }
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
          ? {
              languages: canonicalLanguages,
              concerns: [...config.scope.concerns],
            }
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
    code: ENGINE_STATE.code,
    definition: ENGINE_STATE,
    metadata: { condition: 'unknown-mode' },
  });
  /* v8 ignore stop */
}
