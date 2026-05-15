/**
 * fit command — run fitness checks
 */

import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EXIT_CODES,
  saveSession,
  generateSessionId,
  type CliArgs,
  type CliOutput,
  type TableRow,
  type SummaryOptions,
  type FitDoneResult,
  type ErrorResult,
} from '@opensip-tools/cli-shared';
import { logger, type CheckDisplayEntry } from '@opensip-tools/core';

import { isCheck } from '../framework/check-types.js';
import { defaultRegistry } from '../framework/registry.js';
import { buildScopeBasedFileMap } from '../framework/scope-resolver.js';
import {
  discoverCheckPackages,
  readCheckPackageMetadata,
  readCheckPackagePreferences,
} from '../plugins/check-package-discovery.js';
import { loadAllPlugins } from '../plugins/loader.js';
import { defaultRecipeRegistry } from '../recipes/registry.js';
import { FitnessRecipeService } from '../recipes/service.js';
import { loadSignalersConfig } from '../signalers/index.js';
import { loadTargetsConfig } from '../targets/index.js';

import type { FitnessRecipeServiceCallbacks, CheckSummary } from '../recipes/service-types.js';
import type { FitnessRecipeResult } from '../recipes/types.js';
import type { SignalersConfig } from '../signalers/types.js';


// ---------------------------------------------------------------------------
// Lazy-load fitness checks
// ---------------------------------------------------------------------------

let checksLoaded = false;
let pluginLoadErrors: readonly string[] = [];

/**
 * Merged display map contributed by every loaded check package via the
 * FitPluginExports.checkDisplay field. Each package owns the slugs it
 * registers; on collision the last package loaded wins (no package is
 * privileged). Slugs without an entry fall back to kebab-to-title-case.
 */
const mergedCheckDisplay = new Map<string, CheckDisplayEntry>();
let getCheckDisplayName: (slug: string) => string = defaultDisplayName;
let getCheckIcon: (slug: string) => string = (_slug: string) => '\uD83D\uDD0D';

function defaultDisplayName(slug: string): string {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function rowStatus(cr: { timedOut?: boolean; passed: boolean }): 'TIMEOUT' | 'PASS' | 'FAIL' {
  if (cr.timedOut) return 'TIMEOUT';
  return cr.passed ? 'PASS' : 'FAIL';
}

function rebuildDisplayLookups(): void {
  getCheckDisplayName = (slug) => {
    const entry = mergedCheckDisplay.get(slug);
    return entry ? entry[1] : defaultDisplayName(slug);
  };
  getCheckIcon = (slug) => {
    const entry = mergedCheckDisplay.get(slug);
    return entry ? entry[0] : '\uD83D\uDD0D';
  };
}

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
 * Pre-load hook the CLI registers via setPreLoadHook(). Lets the CLI
 * inject CLI-only behavior (e.g. project-plugin auto-sync) without
 * fitness needing to import CLI internals. Called once before the
 * first ensureChecksLoaded() in this process.
 */
export type PreLoadHook = (projectDir: string) => Promise<void>;

let preLoadHook: PreLoadHook | undefined;

/** Register a hook the CLI runs before fitness loads checks. */
export function setPreLoadHook(hook: PreLoadHook | undefined): void {
  preLoadHook = hook;
}

export async function ensureChecksLoaded(projectDir?: string): Promise<void> {
  if (checksLoaded) return;

  // 0. CLI-injected pre-load hook (auto-sync project plugins, etc).
  //    Skipped when no hook is registered (e.g. running fitness via the
  //    Tool API outside the CLI).
  if (projectDir && preLoadHook) {
    await preLoadHook(projectDir);
  }

  // 1. Load fit plugins — discovers .mjs files in
  //    <projectDir>/opensip-tools/fit/{checks,recipes}/ and any
  //    npm packages declared in plugins.fit in the project config.
  //
  //    Bundled language adapters (TypeScript, Rust, Python, etc.)
  //    are registered separately by the CLI bootstrap; fitness
  //    doesn't take direct deps on @opensip-tools/lang-* packages,
  //    and v3 has no project-local 'lang' plugin discovery path
  //    (the lang adapter set is fixed and shipped with the CLI).
  const pluginResult = await loadAllPlugins('fit', projectDir);
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

  // 3. Discover and load every @opensip-tools/checks-* package installed
  //    in node_modules. No package is privileged — what used to be a
  //    hardcoded `import('@opensip-tools/checks-builtin')` is now an
  //    ordinary npm dependency declared by @opensip-tools/cli and
  //    discovered via discoverCheckPackages() like every other pack.
  //    Project config can override (plugins.checkPackages: [...]) or
  //    opt out (plugins.autoDiscoverChecks: false).
  //
  //    `projectDir` is the discovery anchor — discoverCheckPackages
  //    walks up to ancestor node_modules from there. When called
  //    without one (e.g. ad-hoc `opensip-tools fit` in an unconfigured
  //    dir) we fall back to the CLI's own install dir so the bundled
  //    deps still resolve.
  const discoveryAnchor = projectDir ?? cliInstallDir();
  const checksRegistered = await loadDiscoveredCheckPackages(discoveryAnchor);

  // 4. No-checks-loaded guard. Silent zero-checks would let a misconfig
  //    or missing dep produce a green run that scanned nothing — the
  //    exact failure mode the CLI exists to prevent. Warn loudly.
  if (checksRegistered === 0) {
    const msg =
      'opensip-tools: no check packages were loaded. ' +
      'Install at least one @opensip-tools/checks-* package, ' +
      'or declare plugins.checkPackages in opensip-tools.config.yml.\n';
    process.stderr.write(msg);
    logger.warn({
      evt: 'cli.check_packages.empty',
      module: 'cli:fit',
      msg: 'no check packages loaded',
    });
  }

  rebuildDisplayLookups();
  checksLoaded = true;
}

/**
 * Resolve the directory the CLI was installed into, used as a discovery
 * fallback when no projectDir is supplied. Walks up from this module's
 * URL to the @opensip-tools/cli package root so node_modules lookup
 * sees the CLI's own dependency tree (which now contains checks-builtin
 * and any other check packages declared in cli/package.json).
 */
function cliInstallDir(): string {
  // import.meta.url points at this file inside the CLI's dist/. The CLI
  // package root is two levels up from dist/commands/. Resolve via the
  // Node URL → path bridge to keep this OS-agnostic.
  const thisFile = fileURLToPath(import.meta.url);
  return dirname(dirname(dirname(thisFile)));
}

/**
 * Load every check package returned by discoverCheckPackages(). Each
 * package's main entry should follow the FitPluginExports contract:
 *
 *   - `checks`: readonly Check[]                (required)
 *   - `checkDisplay`: { [slug]: [icon, name] }  (optional)
 *
 * Errors loading any one package don't fail the others — they surface
 * to stderr the same way fit-domain plugin failures do.
 *
 * Returns the total number of checks registered across all loaded
 * packages, so the caller can warn when zero packages contributed
 * anything (a silent green run scanning nothing is the failure mode
 * we want to make impossible).
 */
async function loadDiscoveredCheckPackages(projectDir: string): Promise<number> {
  const prefs = readCheckPackagePreferences(projectDir);
  const discovered = discoverCheckPackages({
    projectDir,
    explicitPackages: prefs.checkPackages,
    autoDiscover: prefs.autoDiscoverChecks,
  });
  let totalRegistered = 0;
  for (const pkg of discovered) {
    const meta = readCheckPackageMetadata(pkg.packageDir);
    if (!meta) {
      process.stderr.write(`opensip-tools: check package ${pkg.name} has no readable package.json — skipping\n`);
      continue;
    }
    try {
      const moduleUrl = pathToFileURL(meta.mainEntry).href;
      const mod = (await import(moduleUrl)) as {
        checks?: unknown;
        checkDisplay?: unknown;
      };
      const checks = mod.checks;
      if (!Array.isArray(checks)) {
        process.stderr.write(`opensip-tools: check package ${pkg.name} does not export a "checks" array — skipping\n`);
        continue;
      }
      let registered = 0;
      for (const check of checks) {
        if (isCheck(check)) {
          defaultRegistry.register(check, pkg.name);
          registered++;
        }
      }
      totalRegistered += registered;
      mergeCheckDisplay(pkg.name, mod.checkDisplay);
      logger.info({
        evt: 'cli.check_package.loaded',
        module: 'cli:fit',
        name: pkg.name,
        checksRegistered: registered,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`opensip-tools: failed to load check package ${pkg.name}: ${msg}\n`);
      logger.warn({
        evt: 'cli.check_package.load_failed',
        module: 'cli:fit',
        name: pkg.name,
        error: msg,
      });
    }
  }
  return totalRegistered;
}

/**
 * Merge a check package's display map into the CLI-wide registry.
 *
 * Validates each entry is a `[icon, name]` tuple before accepting it —
 * a malformed `checkDisplay` export from a third-party package shouldn't
 * crash the run. Bad entries are dropped silently with a debug log so
 * the user still gets a (worse-formatted) result rather than a hang.
 *
 * On collision, last package loaded wins. That's intentional: it lets
 * a downstream package override a base package's display name without
 * having to touch the original.
 */
function mergeCheckDisplay(packageName: string, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  for (const [slug, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === 'string' &&
      typeof entry[1] === 'string'
    ) {
      mergedCheckDisplay.set(slug, [entry[0], entry[1]] as const);
    } else {
      logger.debug({
        evt: 'cli.check_package.bad_display_entry',
        module: 'cli:fit',
        packageName,
        slug,
      });
    }
  }
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

export function formatValidatedColumn(totalItems: number | undefined, itemType = 'items'): string {
  // No meaningful count: external tool checks, errored checks, or checks with no file scanning
  if (!totalItems) return '—';
  // Use singular for count of 1, plural otherwise (e.g., "1 file", "450 files", "13 packages")
  const singular = itemType.endsWith('s') ? itemType.slice(0, -1) : itemType;
  return totalItems === 1 ? `${totalItems} ${singular}` : `${totalItems} ${itemType}`;
}

// ---------------------------------------------------------------------------
// executeFit — main fit command (returns data, no console output)
// ---------------------------------------------------------------------------

// eslint-disable-next-line sonarjs/cognitive-complexity -- top-level CLI command flow: validates args, resolves config, runs recipes, persists results — distinct phases that read better inline
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
  let signalersConfig: SignalersConfig;
  let targetsResult: ReturnType<typeof loadTargetsConfig>;
  try {
    signalersConfig = loadSignalersConfig(args.cwd, args.config);
    targetsResult = loadTargetsConfig(args.cwd, args.config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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

  // Phase 9: validate that every language declared in the targets config
  // has a registered LanguageAdapter. Warn loudly when a target asks for
  // a language we don't know how to handle — silent acceptance would let
  // users ship configs that scan files but produce wrong results.
  {
    const { defaultLanguageRegistry: langRegistry } = await import('@opensip-tools/core');
    const knownLanguages = new Set<string>(langRegistry.list().flatMap((a) => [a.id, ...(a.aliases ?? [])]));
    const unknownLanguages = new Set<string>()
    for (const target of targetRegistry.getAll()) {
      const langs = target.config.languages ?? []
      for (const lang of langs) {
        if (!knownLanguages.has(lang)) unknownLanguages.add(lang)
      }
    }
    if (unknownLanguages.size > 0) {
      const list = [...unknownLanguages].sort().join(', ')
      const known = [...knownLanguages].filter((l) => !l.startsWith('rs') && !l.startsWith('py')).slice(0, 8).join(', ')
      process.stderr.write(
        `opensip-tools: target config declares unknown language(s): ${list}. ` +
        `Known languages: ${[...knownLanguages].sort().join(', ')}. ` +
        `Files in unknown languages will scan with no string/comment filtering.\n`,
      );
      logger.warn({
        evt: 'cli.config.unknown_languages',
        module: 'cli:fit',
        unknown: [...unknownLanguages],
        known: [...knownLanguages],
      });
      // Reference `known` to avoid unused-var lint without changing the user-facing message.
      void known
    }
  }

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
  // Forward globalExcludes from the project config so the matchFiles()
  // fileCache fallback honors them. Without this, scope-empty checks
  // (e.g. file-length-limit) scan every prewarmed file regardless of
  // whether the project config told us to exclude it.
  const service = new FitnessRecipeService({
    cwd: args.cwd,
    checkTargetFiles,
    callbacks,
    disabledChecks,
    includeViolations: true,
    globalExcludes: targetsConfig.globalExcludes,
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
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
    status: rowStatus(cr),
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
