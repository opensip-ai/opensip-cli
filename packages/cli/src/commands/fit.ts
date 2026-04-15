/**
 * fit command — run fitness checks
 */

import {
  defaultRegistry,
  FitnessRecipeService, type FitnessRecipeServiceCallbacks, type CheckSummary,
  type FitnessRecipeResult,
  defaultRecipeRegistry,
  buildScopeBasedFileMap,
  loadTargetsConfig, loadSignalersConfig,
  logger,
} from '@opensip-tools/core';

import type { CliOutput, TableRow, SummaryOptions, FitDoneResult, ErrorResult } from '../types.js';
import { EXIT_CODES } from '../exit-codes.js';
import { saveSession, generateSessionId } from '../persistence/store.js';
import type { CliArgs } from '../types.js';

// ---------------------------------------------------------------------------
// Lazy-load fitness checks
// ---------------------------------------------------------------------------

let checksLoaded = false;
let getCheckDisplayName: (slug: string) => string = (slug) =>
  slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
let getCheckIcon: (slug: string) => string = () => '\uD83D\uDD0D';

const BUILTIN_NAMESPACE = '@opensip-tools/checks-builtin';

export async function ensureChecksLoaded(): Promise<void> {
  if (checksLoaded) return;

  // 1. Load plugins from ~/.opensip-tools/fit/
  const { loadAllPlugins } = await import('@opensip-tools/core');
  const pluginResult = await loadAllPlugins('fit');
  if (pluginResult.errors.length > 0) {
    for (const err of pluginResult.errors) {
      logger.warn({ evt: 'cli.plugin.warning', message: err });
    }
  }

  // 2. Load built-in checks directly from checks-builtin
  const builtin = await import('@opensip-tools/checks-builtin');
  for (const check of builtin.checks) {
    defaultRegistry.register(check, BUILTIN_NAMESPACE);
  }
  getCheckDisplayName = builtin.getCheckDisplayName;
  getCheckIcon = builtin.getCheckIcon;

  checksLoaded = true;
}

/** Get display name for a check slug (available after ensureChecksLoaded) */
export function getDisplayName(slug: string): string {
  return getCheckDisplayName(slug);
}

/** Get the number of enabled checks (available after ensureChecksLoaded) */
export function getEnabledCheckCount(): number {
  return defaultRegistry.listEnabled().length;
}

/** Get icon for a check slug (available after ensureChecksLoaded) */
export function getIcon(slug: string): string {
  return getCheckIcon(slug);
}

// ---------------------------------------------------------------------------
// Formatting helpers (used to build TableRow data)
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatValidatedColumn(totalItems: number | undefined, itemType: string | undefined): string {
  // No meaningful count: external tool checks, errored checks, or checks with no file scanning
  if (!totalItems) return '—';
  // Use singular for count of 1, plural otherwise (e.g., "1 file", "450 files", "13 packages")
  const label = itemType ?? 'items';
  const singular = label.endsWith('s') ? label.slice(0, -1) : label;
  return totalItems === 1 ? `${totalItems} ${singular}` : `${totalItems} ${label}`;
}

// ---------------------------------------------------------------------------
// executeFit — main fit command (returns data, no console output)
// ---------------------------------------------------------------------------

export async function executeFit(
  args: CliArgs,
  onProgress?: (completed: number, total: number) => void,
): Promise<{ result: FitDoneResult; output: CliOutput } | { result: ErrorResult; output?: undefined }> {
  logger.info({ evt: 'cli.checks.loading' });
  await ensureChecksLoaded();
  logger.info({ evt: 'cli.checks.loaded', checkCount: defaultRegistry.listEnabled().length });

  // Determine recipe: --check and --tags each create an ad-hoc recipe;
  // otherwise use a named recipe. --check takes precedence over --recipe
  // so "opensip-tools fit --check <slug>" runs just that slug.
  const useAdHoc = args.check != null || args.tags != null;
  const recipeName = useAdHoc ? undefined : (args.recipe ?? 'default');
  if (recipeName && !defaultRecipeRegistry.has(recipeName)) {
    return {
      result: {
        type: 'error',
        message: `Unknown recipe '${recipeName}'.`,
        suggestion: 'Run opensip-tools fit --recipes to see available recipes.',
        exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      },
    };
  }

  // -- Target resolution --
  let checkTargetFiles: ReadonlyMap<string, readonly string[]> | undefined;
  let disabledChecks: readonly string[] = [];
  let configFound = false;

  try {
    const { registry: targetRegistry, config: targetsConfig } = loadTargetsConfig(args.cwd);
    configFound = true;

    const allChecks = defaultRegistry.listSlugs().map((key) => {
      const check = defaultRegistry.getBySlug(key);
      return { slug: check?.config.slug ?? key, scope: check?.config.checkScope };
    });
    const scopeMap = buildScopeBasedFileMap(allChecks, targetRegistry, targetsConfig, args.cwd);
    if (scopeMap.size > 0) {
      checkTargetFiles = scopeMap;
    }
  } catch (err) {
    // Distinguish "no config" (fine — use built-in file cache) from "config
    // present but invalid" (user needs to see this, not silent defaults).
    const message = err instanceof Error ? err.message : String(err);
    if (!/No targets config found/.test(message)) {
      logger.warn({ evt: 'cli.config.targets.invalid', message });
    }
  }

  // Load signalers config for disabledChecks and CI thresholds. The loader
  // itself is self-healing (logs warnings, returns defaults), so any error
  // here is truly exceptional and worth surfacing in logs.
  let signalersConfig: import('@opensip-tools/core').SignalersConfig | undefined;
  try {
    signalersConfig = loadSignalersConfig(args.cwd);
    disabledChecks = signalersConfig.fitness.disabledChecks;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ evt: 'cli.config.signalers.load_failed', message });
  }

  const label = args.tags ? `tags: ${args.tags}` : `recipe ${recipeName ?? 'default'}`;

  // -- Progress callbacks --
  const callbacks: FitnessRecipeServiceCallbacks = {
    onCheckStart(checkSlug: string, index: number, total: number) {
      logger.debug({ evt: 'cli.check.start', checkSlug, index, total });
      onProgress?.(index, total);
    },
    onCheckComplete(checkSlug: string, summary: CheckSummary, index: number, total: number) {
      logger.debug({ evt: 'cli.check.complete', checkSlug, passed: summary.passed, errors: summary.errors, warnings: summary.warnings, durationMs: summary.durationMs });
      onProgress?.(index + 1, total);
    },
  };

  // -- Execute via FitnessRecipeService --
  const service = new FitnessRecipeService({
    cwd: args.cwd,
    checkTargetFiles,
    callbacks,
    disabledChecks,
    includeViolations: true,
  });

  let fitnessResult: FitnessRecipeResult;
  try {
    if (args.check) {
      fitnessResult = await service.start(FitnessRecipeService.createAdHocRecipe({ check: args.check }));
    } else if (args.tags) {
      const tagFilters = args.tags.split(',').map(t => t.trim()).filter(Boolean);
      fitnessResult = await service.start(FitnessRecipeService.createAdHocRecipe({ tagFilters }));
    } else {
      fitnessResult = await service.start(recipeName!);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      result: {
        type: 'error',
        message: `Fitness run failed: ${msg}`,
        exitCode: EXIT_CODES.RUNTIME_ERROR,
      },
    };
  }

  // -- Format output from recipe result --
  const { summary, checkResults, durationMs } = fitnessResult;
  const score = summary.totalChecks > 0
    ? Math.round((summary.passedChecks / summary.totalChecks) * 100)
    : 0;

  // Build structured output
  const output: CliOutput = {
    version: '1.0',
    tool: 'fit',
    timestamp: new Date().toISOString(),
    recipe: recipeName,
    score,
    passed: summary.failedChecks === 0,
    summary: {
      total: summary.totalChecks,
      passed: summary.passedChecks,
      failed: summary.failedChecks,
      errors: summary.totalErrors,
      warnings: summary.totalWarnings,
    },
    checks: checkResults.map(cr => ({
      checkSlug: cr.checkSlug,
      passed: cr.passed,
      violationCount: cr.violationCount,
      findings: (cr.violations ?? []).map(v => ({
        ruleId: cr.checkSlug,
        message: v.message,
        severity: v.severity,
        filePath: v.file,
        line: v.line,
        column: v.column,
        suggestion: v.suggestion,
      })),
      durationMs: cr.durationMs,
    })),
    durationMs,
  };

  // Persist session for history and dashboard
  try {
    saveSession({
      id: generateSessionId(),
      tool: 'fit',
      timestamp: output.timestamp,
      cwd: args.cwd,
      recipe: recipeName,
      score,
      passed: output.passed,
      summary: output.summary,
      checks: output.checks,
      durationMs,
    });
  } catch {
    // Best effort — don't fail the run if persistence fails
  }

  // Build table rows
  const tableRows: TableRow[] = checkResults.map(cr => ({
    check: getCheckDisplayName(cr.checkSlug),
    status: cr.timedOut ? 'TIMEOUT' as const : cr.passed ? 'PASS' as const : 'FAIL' as const,
    errors: cr.errorCount,
    warnings: cr.warningCount,
    validated: formatValidatedColumn(cr.totalItems, cr.itemType),
    ignored: cr.ignoredCount,
    duration: formatDuration(cr.durationMs),
    durationMs: cr.durationMs,
  }));

  // Build summary
  const summaryOpts: SummaryOptions = {
    passed: summary.passedChecks,
    failed: summary.failedChecks,
    totalErrors: summary.totalErrors,
    totalWarnings: summary.totalWarnings,
    totalIgnored: summary.totalIgnored,
    durationMs,
  };

  // Determine exit code from config thresholds
  // failOnErrors: fail if total errors >= this value (default: 1, 0 = never fail on errors)
  // failOnWarnings: fail if total warnings >= this value (default: 0 = never fail on warnings)
  const failOnErrors = signalersConfig?.fitness.failOnErrors ?? 1;
  const failOnWarnings = signalersConfig?.fitness.failOnWarnings ?? 0;
  const shouldFail =
    (failOnErrors > 0 && summary.totalErrors >= failOnErrors) ||
    (failOnWarnings > 0 && summary.totalWarnings >= failOnWarnings);

  // Build findings if requested
  let findings: FitDoneResult['findings'];
  if ((args.findings || args.verbose) && (summary.totalErrors + summary.totalWarnings) > 0) {
    findings = {
      checks: checkResults
        .filter(cr => cr.errorCount > 0 || cr.warningCount > 0 || cr.error)
        .map(cr => ({
          checkSlug: cr.checkSlug,
          errorCount: cr.errorCount,
          warningCount: cr.warningCount,
          error: cr.error,
          violations: cr.violations?.map(v => ({
            severity: v.severity,
            message: v.message,
            file: v.file,
            line: v.line,
            suggestion: v.suggestion,
          })),
        })),
    };
  }

  const result: FitDoneResult = {
    type: 'fit-done',
    rows: tableRows,
    summary: summaryOpts,
    label,
    cwd: args.cwd,
    findings,
    shouldFail,
    configFound,
  };

  logger.info({ evt: 'cli.fit.complete', score, passed: fitnessResult.success, totalChecks: summary.totalChecks, durationMs });

  return { result, output };
}
