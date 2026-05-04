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
let pluginLoadErrors: readonly string[] = [];
let getCheckDisplayName: (slug: string) => string = (slug) =>
  slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
let getCheckIcon: (slug: string) => string = () => '\uD83D\uDD0D';

/**
 * Plugin load errors recorded during the most recent ensureChecksLoaded() call.
 * Read by runFit to fail the run if any plugin failed to import \u2014 otherwise a
 * malicious or broken plugin could silently suppress its own checks while the
 * CLI exits 0, masking a compliance failure or a supply-chain compromise.
 */
export function getPluginLoadErrors(): readonly string[] {
  return pluginLoadErrors;
}

/**
 * Install declared project-local plugins when the `.opensip-tools/<domain>/
 * node_modules/` dir is missing or clearly stale (missing declared deps).
 *
 * Runs silently when nothing is needed. Prints a one-line status when
 * it does work so the user understands the pause before checks start.
 */
async function maybeAutoSyncProjectPlugins(projectDir: string): Promise<void> {
  const { readProjectPluginsList, getProjectPluginDir } = await import('@opensip-tools/core')
  const { existsSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const domains = ['fit', 'sim', 'asm'] as const
  const missingDomains: string[] = []

  for (const domain of domains) {
    const specs = readProjectPluginsList(projectDir, domain)
    if (!specs || specs.length === 0) continue

    const dir = getProjectPluginDir(projectDir, domain)
    const pkgJsonPath = join(dir, 'package.json')
    const nodeModulesPath = join(dir, 'node_modules')

    if (!existsSync(pkgJsonPath) || !existsSync(nodeModulesPath)) {
      missingDomains.push(domain)
      continue
    }

    // Shallow staleness check — count declared deps whose node_modules
    // entry is present. A truly exhaustive check would compare the
    // config list against node_modules; this is good enough to catch
    // the common "first clone" case.
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { dependencies?: Record<string, string> }
      const installedCount = Object.keys(pkg.dependencies ?? {}).length
      if (installedCount === 0) missingDomains.push(domain)
    } catch {
      missingDomains.push(domain)
    }
  }

  if (missingDomains.length === 0) return

  process.stderr.write(
    `opensip-tools: installing project-local plugins (${missingDomains.join(', ')})...\n`,
  )
  const { pluginSync } = await import('./project-plugins.js')
  for (const domain of missingDomains) {
    try {
      await pluginSync(projectDir, domain)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`opensip-tools: plugin sync failed for ${domain}: ${msg}\n`)
    }
  }
}

const BUILTIN_NAMESPACE = '@opensip-tools/checks-builtin';

export async function ensureChecksLoaded(projectDir?: string): Promise<void> {
  if (checksLoaded) return;

  // 0. Auto-sync: if the project declares plugins but the project-local
  //    dir is empty, transparently install them before loading. Matches
  //    the onboarding story of `git clone && opensip-tools fit` — no
  //    explicit setup step. Silent when nothing to sync.
  if (projectDir) {
    await maybeAutoSyncProjectPlugins(projectDir)
  }

  // 1. Load plugins — project-local `<projectDir>/.opensip-tools/fit/`
  //    when the project config declares `plugins.fit`, otherwise
  //    `~/.opensip-tools/fit/`. Pass-through baseDir=undefined, so
  //    resolvePluginDir picks the default.
  const { loadAllPlugins } = await import('@opensip-tools/core');
  const pluginResult = await loadAllPlugins('fit', undefined, projectDir);
  pluginLoadErrors = pluginResult.errors;
  if (pluginResult.errors.length > 0) {
    // Surface plugin load errors to the user. The logger is silenced in
    // normal CLI runs, so a structured-log-only failure was invisible
    // before. Print one line per failure to stderr — short, actionable,
    // and doesn't clobber stdout (which carries results + --json).
    for (const err of pluginResult.errors) {
      process.stderr.write(`opensip-tools: plugin failed to load — ${err}\n`);
      logger.warn({ evt: 'cli.plugin.warning', module: 'cli:fit', message: err });
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
  logger.info({ evt: 'cli.checks.loading', module: 'cli:fit' });
  await ensureChecksLoaded(args.cwd);
  logger.info({ evt: 'cli.checks.loaded', module: 'cli:fit', checkCount: defaultRegistry.listEnabled().length });

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

  // -- Config resolution --
  // Both loaders share the same project config file. A missing file is a
  // HARD error: file-based checks would silently produce zero findings,
  // making the scan look green when it actually never ran. The resolver
  // throws with a message that enumerates every path it attempted.
  let signalersConfig: import('@opensip-tools/core').SignalersConfig;
  let targetsResult: ReturnType<typeof loadTargetsConfig>;
  try {
    signalersConfig = loadSignalersConfig(args.cwd, args.config);
    targetsResult = loadTargetsConfig(args.cwd, args.config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ evt: 'cli.config.load_failed', module: 'cli:fit', message });
    return {
      result: {
        type: 'error',
        message,
        suggestion: "Run 'opensip-tools init' to scaffold a config, or pass --config <path> to point at an existing one.",
        exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      },
    };
  }

  const disabledChecks = signalersConfig.fitness.disabledChecks;
  const { registry: targetRegistry, config: targetsConfig } = targetsResult;
  const configFound = true;

  const allChecks = defaultRegistry.listSlugs().map((key) => {
    const check = defaultRegistry.getBySlug(key);
    return { slug: check?.config.slug ?? key, scope: check?.config.checkScope };
  });
  const scopeMap = buildScopeBasedFileMap(allChecks, targetRegistry, targetsConfig, args.cwd);
  const checkTargetFiles = scopeMap.size > 0 ? scopeMap : undefined;

  const label = args.tags ? `tags: ${args.tags}` : `recipe ${recipeName ?? 'default'}`;

  // -- Progress callbacks --
  //
  // Monotonic completed-count:
  //
  // The service fires onCheckStart(slug, displayIndex, total) when a check
  // STARTS and onCheckComplete(slug, summary, displayIndex, total) when it
  // FINISHES. Under parallel execution `displayIndex` is the check's
  // position in the queue (1..total), not "how many have completed" — so
  // the last started check's index hops above the current completion
  // tally and then "resets" down when an earlier check finishes. The UI
  // showed `147/148 → 121/148 → 78/148` because each event fired with a
  // different in-flight check's queue position.
  //
  // The progress bar wants a monotonic counter. Track completed locally,
  // increment only on onCheckComplete, ignore onCheckStart's index. The
  // counter is strictly non-decreasing and always reflects "N of M
  // checks done."
  let completedCount = 0;
  const callbacks: FitnessRecipeServiceCallbacks = {
    onCheckStart(checkSlug: string, index: number, total: number) {
      logger.debug({ evt: 'cli.check.start', module: 'cli:fit', checkSlug, index, total });
      // Emit current completed count so the UI shows activity without
      // moving the bar backward on start events.
      onProgress?.(completedCount, total);
    },
    onCheckComplete(checkSlug: string, summary: CheckSummary, index: number, total: number) {
      logger.debug({ evt: 'cli.check.complete', module: 'cli:fit', checkSlug, passed: summary.passed, errors: summary.errors, warnings: summary.warnings, durationMs: summary.durationMs });
      completedCount++;
      onProgress?.(completedCount, total);
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
    passed: summary.failedChecks === 0 && pluginLoadErrors.length === 0,
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
    pluginLoadErrors.length > 0 ||
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

  logger.info({ evt: 'cli.fit.complete', module: 'cli:fit', score, passed: fitnessResult.success, totalChecks: summary.totalChecks, durationMs });

  return { result, output };
}
