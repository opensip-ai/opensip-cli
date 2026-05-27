/**
 * fit command — run fitness checks
 */

import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EXIT_CODES,
  SessionRepo,
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; fit's executeFit signature is fed via fitOptsToCliArgs until the rip-out
  type CliArgs,
  type CliOutput,
  type TableRow,
  type SummaryOptions,
  type FitDoneResult,
  type ErrorResult,
} from '@opensip-tools/contracts';
import {
  discoverPackagesByMarker,
  generatePrefixedId,
  logger,
  registerRecipesFromMod,
  type CheckDisplayEntry,
} from '@opensip-tools/core';


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
import type { DataStore } from '@opensip-tools/datastore';


// ---------------------------------------------------------------------------
// Lazy-load fitness checks
// ---------------------------------------------------------------------------

// Lifecycle singletons. All five are written exactly once per process by
// `ensureChecksLoaded()` (or by the CLI bootstrap, in `preLoadHook`'s case)
// and read by the phase helpers downstream \u2014 `loadFitConfig`,
// `buildCliOutput`, `buildFitDoneResult`, plus the public
// `getPluginLoadErrors` / `getDisplayName` / `getIcon` accessors that
// `FitView` and `dashboard.ts` consume.
//
// They are NOT threaded through a `FitContext` parameter today because two
// external consumers (`FitView` in `@opensip-tools/cli`, `dashboard.ts` in
// this package) reach for the accessors directly \u2014 wiring everything
// through a context object would either break those imports or maintain a
// dual access path. Audit 2026-05-23 F6 documents the trade-off; revisit
// when multi-instance fitness in one process becomes a contract decision
// (prior Finding #10).
//
// Invariant: each binding is set by `ensureChecksLoaded()` and read by the
// phase helpers below; `executeFit`'s phase ordering is sequenced so the
// readers always run after the setter completes.

/** Project directory for which `ensureChecksLoaded` has run to completion.
 * Keyed on the directory so a second invocation against a different
 * project (long-lived host, tests, programmatic API) re-loads plugins
 * and check packages anchored at the new directory. `null` when no
 * projectDir was supplied; `''` is reserved as the "loaded" sentinel
 * for the no-project case. */
let checksLoadedFor: string | null = null;
/** Plugin load failures from the most recent `ensureChecksLoaded` call \u2014
 * read by `buildCliOutput` and `buildFitDoneResult` to fail the run. */
let pluginLoadErrors: readonly string[] = [];

/**
 * Non-fatal user-facing warnings collected during the most recent
 * `ensureChecksLoaded` call (missing check package metadata, packages
 * without a `checks` array, package load failures, plugin load errors,
 * zero-packages-loaded).
 *
 * Replaces direct `process.stderr.write` calls that broke Ink's live-view
 * frame tracking when emitted mid-render. `executeFit` reads these via
 * `getLoadWarnings()` and surfaces them through `FitDoneResult.warnings`,
 * which the renderer displays in the summary block and the JSON/gate
 * paths emit at their own boundary.
 */
let loadWarnings: string[] = [];

/** Warnings collected during the most recent ensureChecksLoaded() call.
 * Returned alongside plugin errors and run-time validation warnings via
 * executeFit's result so the live renderer and JSON output both see them. */
export function getLoadWarnings(): readonly string[] {
  return loadWarnings;
}

/**
 * Merged display map contributed by every loaded check package via the
 * FitPluginExports.checkDisplay field. Each package owns the slugs it
 * registers; on collision the last package loaded wins (no package is
 * privileged). Slugs without an entry fall back to kebab-to-title-case.
 *
 * Lifecycle singleton: populated by `loadDiscoveredCheckPackages` inside
 * `ensureChecksLoaded`; read by `buildFitDoneResult` (via
 * `getCheckDisplayName`) and by `dashboard.ts` (via the exported
 * `getDisplayName` / `getIcon` accessors).
 */
const mergedCheckDisplay = new Map<string, CheckDisplayEntry>();
/** Lifecycle singleton, set by `rebuildDisplayLookups` after
 * `ensureChecksLoaded`; read by `buildFitDoneResult`. */
let getCheckDisplayName: (slug: string) => string = defaultDisplayName;
/** Lifecycle singleton, set by `rebuildDisplayLookups` after
 * `ensureChecksLoaded`; read via the exported `getIcon` accessor. */
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

/** Lifecycle singleton, set by `setPreLoadHook` (called from the CLI
 * bootstrap); read by `ensureChecksLoaded` once per process. */
let preLoadHook: PreLoadHook | undefined;

/** Register a hook the CLI runs before fitness loads checks. */
export function setPreLoadHook(hook: PreLoadHook | undefined): void {
  preLoadHook = hook;
}

export async function ensureChecksLoaded(projectDir?: string): Promise<void> {
  const key = projectDir ?? '';
  if (checksLoadedFor === key) return;

  // Reset per-run warning buffer. Singleton lifetime mirrors checksLoadedFor —
  // a fresh load (new projectDir or first call) starts with no warnings.
  loadWarnings = [];

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
  //    and there's no project-local 'lang' plugin discovery path
  //    (the lang adapter set is fixed and shipped with the CLI).
  const pluginResult = await loadAllPlugins('fit', projectDir);
  pluginLoadErrors = pluginResult.errors;
  if (pluginResult.errors.length > 0) {
    // Plugin load errors go to loadWarnings (rendered via the result) and
    // logger.warn (structured logs). Direct stderr writes are forbidden
    // during live-view runs — they desync Ink's frame tracking.
    for (const err of pluginResult.errors) {
      loadWarnings.push(`plugin failed to load — ${err}`);
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
  const { totalRegistered: checksRegistered, warnings: packWarnings } = await loadDiscoveredCheckPackages(discoveryAnchor);
  for (const w of packWarnings) loadWarnings.push(w);

  // 4. No-checks-loaded guard. Silent zero-checks would let a misconfig
  //    or missing dep produce a green run that scanned nothing — the
  //    exact failure mode the CLI exists to prevent. Warn loudly.
  if (checksRegistered === 0) {
    const msg =
      'no check packages were loaded. ' +
      'Install at least one @opensip-tools/checks-* package, ' +
      'or declare plugins.checkPackages in opensip-tools.config.yml.';
    loadWarnings.push(msg);
    logger.warn({
      evt: 'cli.check_packages.empty',
      module: 'cli:fit',
      msg: 'no check packages loaded',
    });
  }

  rebuildDisplayLookups();
  checksLoadedFor = key;
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
export async function loadDiscoveredCheckPackages(projectDir: string): Promise<LoadDiscoveredResult> {
  const prefs = readCheckPackagePreferences(projectDir);
  const discovered = discoverCheckPackages({
    projectDir,
    explicitPackages: prefs.checkPackages,
    autoDiscover: prefs.autoDiscoverChecks,
    packageScopes: prefs.packageScopes,
  });
  // Marker-based discovery runs in parallel with the name-pattern walk.
  // Customers who declare opensipTools.kind: "fit-pack" in package.json get
  // discovered regardless of npm scope. Dedupe by package name; first
  // occurrence (name-pattern walk) wins so existing customers' telemetry
  // doesn't shift over to a different code path silently.
  const markerDiscovered = discoverPackagesByMarker({ projectDir, kind: 'fit-pack' });
  const seenNames = new Set(discovered.map((p) => p.name));
  const allPacks: readonly { name: string; packageDir: string }[] = [
    ...discovered,
    ...markerDiscovered
      .filter((p) => !seenNames.has(p.name))
      .map((p) => ({ name: p.name, packageDir: p.packageDir })),
  ];
  let totalRegistered = 0;
  const warnings: string[] = [];
  for (const pkg of allPacks) {
    const meta = readCheckPackageMetadata(pkg.packageDir);
    if (!meta) {
      warnings.push(`check package ${pkg.name} has no readable package.json — skipping`);
      continue;
    }
    try {
      const moduleUrl = pathToFileURL(meta.mainEntry).href;
      const mod = (await import(moduleUrl)) as {
        checks?: unknown;
        checkDisplay?: unknown;
        recipes?: unknown;
      };
      const checks = mod.checks;
      if (!Array.isArray(checks)) {
        warnings.push(`check package ${pkg.name} does not export a "checks" array — skipping`);
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
      const { recipesRegistered } = registerRecipesFromMod(mod, defaultRecipeRegistry, {
        namespace: pkg.name,
        onWarn: (evt, message, extra) => {
          logger.warn({
            evt,
            module: 'cli:fit',
            name: pkg.name,
            msg: message,
            ...extra,
          });
        },
      });
      logger.info({
        evt: 'cli.check_package.loaded',
        module: 'cli:fit',
        name: pkg.name,
        checksRegistered: registered,
        recipesRegistered,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      warnings.push(`failed to load check package ${pkg.name}: ${msg}`);
      logger.warn({
        evt: 'cli.check_package.load_failed',
        module: 'cli:fit',
        name: pkg.name,
        error: msg,
      });
    }
  }
  return { totalRegistered, warnings };
}

/**
 * Return shape of `loadDiscoveredCheckPackages`. Warnings are returned
 * (rather than written to a module singleton) so direct callers and tests
 * can read them without depending on `ensureChecksLoaded` having run.
 * `ensureChecksLoaded` merges these into the run-wide `loadWarnings` buffer.
 */
export interface LoadDiscoveredResult {
  readonly totalRegistered: number;
  readonly warnings: readonly string[];
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
// executeFit helpers — each phase pulled out so the orchestration shell
// below stays readable. Helpers return either their data shape or an
// `ErrorResult` so the caller can short-circuit cleanly.
// ---------------------------------------------------------------------------

interface LoadedFitConfig {
  signalersConfig: SignalersConfig;
  targetsConfig: ReturnType<typeof loadTargetsConfig>['config'];
  targetRegistry: ReturnType<typeof loadTargetsConfig>['registry'];
}

/**
 * Resolve `signalersConfig` + `targetsConfig` from the project's
 * opensip-tools.config.yml. Returns an `ErrorResult` instead of throwing
 * so the caller maps it directly to the public failure shape — a
 * missing/invalid config is a HARD error (otherwise file-based checks
 * silently produce zero findings).
 */
function loadFitConfig(
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
  args: CliArgs,
): LoadedFitConfig | { error: ErrorResult } {
  try {
    const signalersConfig = loadSignalersConfig(args.cwd, args.config);
    const targetsResult = loadTargetsConfig(args.cwd, args.config);
    return {
      signalersConfig,
      targetsConfig: targetsResult.config,
      targetRegistry: targetsResult.registry,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ evt: 'cli.config.load_failed', module: 'cli:fit', message });
    return {
      error: {
        type: 'error',
        message,
        suggestion: "Run 'opensip-tools init' to scaffold a config, or pass --config <path> to point at an existing one.",
        exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      },
    };
  }
}

/**
 * Warn loudly when the targets config declares languages with no
 * registered adapter. Silent acceptance would let users ship configs
 * that scan files but skip the language-aware string/comment filtering.
 *
 * Returns warning strings (one per unknown-language batch) rather than
 * writing to stderr — stderr writes during the Ink live view desync the
 * renderer's frame tracking. `executeFit` collects these and threads
 * them into `FitDoneResult.warnings`.
 *
 * Async only because the language registry is imported via dynamic
 * import to keep the executeFit body free of fitness↔core import
 * arrows beyond the kernel barrel.
 */
async function validateLanguagesAgainstAdapters(
  targetRegistry: LoadedFitConfig['targetRegistry'],
): Promise<readonly string[]> {
  const { defaultLanguageRegistry: langRegistry } = await import('@opensip-tools/core');
  const knownLanguages = new Set<string>(langRegistry.list().flatMap((a) => [a.id, ...(a.aliases ?? [])]));
  const unknownLanguages = new Set<string>();
  for (const target of targetRegistry.getAll()) {
    const langs = target.config.languages ?? [];
    for (const lang of langs) {
      if (!knownLanguages.has(lang)) unknownLanguages.add(lang);
    }
  }
  if (unknownLanguages.size === 0) return [];

  const list = [...unknownLanguages].sort().join(', ');
  logger.warn({
    evt: 'cli.config.unknown_languages',
    module: 'cli:fit',
    unknown: [...unknownLanguages],
    known: [...knownLanguages],
  });
  return [
    `target config declares unknown language(s): ${list}. ` +
    `Known languages: ${[...knownLanguages].sort().join(', ')}. ` +
    `Files in unknown languages will scan with no string/comment filtering.`,
  ];
}

/**
 * Decide which recipe to execute. `--check` and `--tags` each create an
 * ad-hoc recipe (recipeName=undefined); otherwise look up a named
 * recipe. Returns either the resolved name or `undefined` (ad-hoc), or
 * an `ErrorResult` when the requested name doesn't exist.
 *
 * **Precondition:** must run *after* `ensureChecksLoaded` so that any
 * user-defined recipes (loaded as `.mjs` plugins under
 * `<cwd>/opensip-tools/fit/recipes/`) are present in
 * `defaultRecipeRegistry` by the time the lookup runs. Inverting the two
 * lines silently breaks recipe lookup for plugin-provided recipes.
 */
function selectRecipe(
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
  args: CliArgs,
): { recipeName: string | undefined } | { error: ErrorResult } {
  const useAdHoc = args.check != null || args.tags != null;
  const recipeName = useAdHoc ? undefined : (args.recipe ?? 'default');
  if (recipeName && !defaultRecipeRegistry.has(recipeName)) {
    return {
      error: {
        type: 'error',
        message: `Unknown recipe '${recipeName}'.`,
        suggestion: 'Run opensip-tools fit --recipes to see available recipes.',
        exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      },
    };
  }
  return { recipeName };
}

/**
 * Map a {@link FitnessRecipeResult} onto the shared {@link CliOutput}
 * shape that the dashboard, JSON exporter, and SARIF builder all
 * consume. The same finding shape is produced here and in
 * {@link buildFitDoneResult} below so any change is paired.
 */
function buildCliOutput(
  fitnessResult: FitnessRecipeResult,
  recipeName: string | undefined,
): CliOutput {
  const { summary, checkResults, durationMs } = fitnessResult;
  // Empty-recipe score is 100 to match service.buildResult's formula —
  // gate baselines and the live renderer must agree on the same value
  // or --gate-compare reports a phantom regression on the next run.
  const score = summary.totalChecks > 0
    ? Math.round((summary.passedChecks / summary.totalChecks) * 100)
    : 100;
  return {
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
}

interface BuildFitDoneArgs {
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
  args: CliArgs;
  fitnessResult: FitnessRecipeResult;
  signalersConfig: SignalersConfig;
  recipeName: string | undefined;
  warnings?: readonly string[];
}

/**
 * Build the {@link FitDoneResult} the live renderer / JSON output / gate
 * mode all consume. Computes the configured fail thresholds, the table
 * rows, the optional grouped findings block, and the run label.
 *
 * Pure builder: session persistence (SessionRepo.save) lives at the
 * `executeFit` call site (post-call), not here. Threading `datastore`
 * into `executeFit`'s opts in v2 made it unnecessary to push it into
 * this builder, and keeping the function side-effect-free preserves the
 * D1-phase decomposition. See `executeFit` for the persistence write.
 */
function buildFitDoneResult({ args, fitnessResult, signalersConfig, recipeName, warnings }: BuildFitDoneArgs): FitDoneResult {
  const { summary, checkResults, durationMs } = fitnessResult;

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

  const summaryOpts: SummaryOptions = {
    passed: summary.passedChecks,
    failed: summary.failedChecks,
    totalErrors: summary.totalErrors,
    totalWarnings: summary.totalWarnings,
    totalIgnored: summary.totalIgnored,
    durationMs,
  };

  // Determine exit code from config thresholds.
  // failOnErrors: fail if total errors >= this value (default: 1, 0 = never fail on errors)
  // failOnWarnings: fail if total warnings >= this value (default: 0 = never fail on warnings)
  const failOnErrors = signalersConfig.fitness.failOnErrors ?? 1;
  const failOnWarnings = signalersConfig.fitness.failOnWarnings ?? 0;
  const shouldFail =
    pluginLoadErrors.length > 0 ||
    (failOnErrors > 0 && summary.totalErrors >= failOnErrors) ||
    (failOnWarnings > 0 && summary.totalWarnings >= failOnWarnings);

  let findings: FitDoneResult['findings'];
  if ((args.findings || args.verbose) && (summary.totalErrors + summary.totalWarnings) > 0) {
    findings = {
      checks: checkResults
        .filter(cr => cr.errorCount > 0 || cr.warningCount > 0 || cr.error)
        .map(cr => ({
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
          error: cr.error,
        })),
    };
  }

  const label = args.tags ? `tags: ${args.tags}` : `recipe ${recipeName ?? 'default'}`;

  return {
    type: 'fit-done',
    rows: tableRows,
    summary: summaryOpts,
    label,
    cwd: args.cwd,
    findings,
    shouldFail,
    configFound: true,
    warnings: warnings && warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Wire up CLI-side progress callbacks for the recipe service.
 *
 * Monotonic completed-count: the service fires `onCheckStart(slug,
 * displayIndex, total)` when a check STARTS and
 * `onCheckComplete(slug, summary, displayIndex, total)` when it
 * FINISHES. Under parallel execution `displayIndex` is the check's
 * position in the queue (1..total), not "how many have completed" — so
 * the last-started check's index hops above the current completion
 * tally and then "resets" down when an earlier check finishes (the UI
 * showed `147/148 → 121/148 → 78/148`).
 *
 * The progress bar wants a monotonic counter. We track completed
 * locally, increment only on `onCheckComplete`, and ignore
 * `onCheckStart`'s index. The counter is strictly non-decreasing and
 * always reflects "N of M checks done."
 */
function buildFitCallbacks(
  onProgress?: (completed: number, total: number) => void,
): FitnessRecipeServiceCallbacks {
  let completedCount = 0;
  return {
    onCheckStart(checkSlug: string, index: number, total: number) {
      logger.debug({ evt: 'cli.check.start', module: 'cli:fit', checkSlug, index, total });
      onProgress?.(completedCount, total);
    },
    onCheckComplete(checkSlug: string, summary: CheckSummary, index: number, total: number) {
      logger.debug({ evt: 'cli.check.complete', module: 'cli:fit', checkSlug, passed: summary.passed, errors: summary.errors, warnings: summary.warnings, durationMs: summary.durationMs });
      completedCount++;
      onProgress?.(completedCount, total);
    },
  };
}

/** Run the recipe (or ad-hoc selector built from `--check` / `--tags`). */
async function runRecipeOrAdHoc(
  service: FitnessRecipeService,
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
  args: CliArgs,
  recipeName: string | undefined,
): Promise<FitnessRecipeResult | { error: ErrorResult }> {
  try {
    if (args.check) {
      return await service.start(FitnessRecipeService.createAdHocRecipe({ check: args.check }));
    }
    if (args.tags) {
      const tagFilters = args.tags.split(',').map(t => t.trim()).filter(Boolean);
      return await service.start(FitnessRecipeService.createAdHocRecipe({ tagFilters }));
    }
    return await service.start(recipeName!);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      error: {
        type: 'error',
        message: `Fitness run failed: ${msg}`,
        exitCode: EXIT_CODES.RUNTIME_ERROR,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// executeFit — main fit command (returns data, no console output)
// ---------------------------------------------------------------------------

/**
 * Run a fitness session end-to-end. Sequences the phase helpers in this
 * file in a fixed order:
 *
 *   1. `ensureChecksLoaded` — loads check packs and fit-domain plugins
 *      (must run first; populates `defaultRegistry` and
 *      `defaultRecipeRegistry` for downstream phases).
 *   2. `loadFitConfig` — resolves `signalersConfig` + `targetsConfig`
 *      from `opensip-tools.config.yml`. Sequenced before `selectRecipe`
 *      so a missing/invalid config surfaces before recipe-name
 *      validation — the config tells the user what recipes exist, so
 *      the config error is the more useful message of the two.
 *   3. `selectRecipe` — looks up the requested recipe in
 *      `defaultRecipeRegistry` (populated by step 1). Has a hard
 *      precondition on `ensureChecksLoaded`; see its JSDoc.
 *   4. `validateLanguagesAgainstAdapters` — warns on unknown languages.
 *   5. Build scope-based file map → run recipe → build outputs.
 *
 * The phase helpers read from module-singleton state set by step 1
 * (see the lifecycle singletons block at the top of this file). The
 * ordering here is the contract that lets those reads be safe.
 */
/**
 * Optional dependencies threaded through `executeFit`. Both fields are
 * optional so test harnesses and the JSON/gate paths can call
 * `executeFit(args)` exactly as before.
 *
 *   - `onProgress` — wired to `FitnessRecipeService` callbacks; FitView
 *     drives the live progress bar from this callback.
 *   - `datastore` — when supplied, the run is persisted via
 *     `SessionRepo.save(...)` after `buildCliOutput`. Errors during the
 *     save are best-effort: a failed write logs `cli.fit.session.save_failed`
 *     and is swallowed so a SQLite hiccup never fails an otherwise
 *     successful fitness run. Matches the legacy v1 `saveSession` semantics
 *     (file-based) and the v2 graph-engine `persistSession` policy.
 */
export interface ExecuteFitOptions {
  onProgress?: (completed: number, total: number) => void;
  datastore?: DataStore;
}

export async function executeFit(
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
  args: CliArgs,
  opts: ExecuteFitOptions = {},
): Promise<{ result: FitDoneResult; output: CliOutput } | { result: ErrorResult; output?: undefined }> {
  logger.info({ evt: 'cli.checks.loading', module: 'cli:fit' });
  await ensureChecksLoaded(args.cwd);
  logger.info({ evt: 'cli.checks.loaded', module: 'cli:fit', checkCount: defaultRegistry.listEnabled().length });

  const configResult = loadFitConfig(args);
  if ('error' in configResult) return { result: configResult.error };
  const { signalersConfig, targetsConfig, targetRegistry } = configResult;

  const recipePick = selectRecipe(args);
  if ('error' in recipePick) return { result: recipePick.error };
  const { recipeName } = recipePick;

  const validationWarnings = await validateLanguagesAgainstAdapters(targetRegistry);

  const allChecks = defaultRegistry.listSlugs().map((key) => {
    const check = defaultRegistry.getBySlug(key);
    return { slug: check?.config.slug ?? key, scope: check?.config.checkScope };
  });
  const scopeMap = buildScopeBasedFileMap(allChecks, targetRegistry, targetsConfig, args.cwd);
  const checkTargetFiles = scopeMap.size > 0 ? scopeMap : undefined;

  const service = new FitnessRecipeService({
    cwd: args.cwd,
    checkTargetFiles,
    callbacks: buildFitCallbacks(opts.onProgress),
    disabledChecks: signalersConfig.fitness.disabledChecks,
    includeViolations: true,
    globalExcludes: targetsConfig.globalExcludes,
  });

  const fitResultOrError = await runRecipeOrAdHoc(service, args, recipeName);
  if ('error' in fitResultOrError) return { result: fitResultOrError.error };
  const fitnessResult = fitResultOrError;

  const output = buildCliOutput(fitnessResult, recipeName);

  // v2 persistence: when bootstrap supplied a datastore, write the
  // session via SessionRepo. Best-effort — a SQLite write failure never
  // fails an otherwise-successful fitness run (mirrors v1's saveSession
  // policy and graph's persistSession). `buildFitDoneResult` stays a
  // pure builder; the side effect lives here so every executeFit caller
  // (FitView, runJsonMode, runGateMode) gets the write for free as long
  // as they pass `datastore` through.
  if (opts.datastore) {
    persistFitSession(opts.datastore, args, output);
  }

  // Collect warnings from check loading (ensureChecksLoaded → loadWarnings)
  // and from config validation (validateLanguagesAgainstAdapters). Both flow
  // through the result rather than direct stderr writes so the live renderer
  // can surface them without breaking Ink's frame tracking.
  const warnings = [...getLoadWarnings(), ...validationWarnings];

  const result = buildFitDoneResult({ args, fitnessResult, signalersConfig, recipeName, warnings });

  logger.info({ evt: 'cli.fit.complete', module: 'cli:fit', score: output.score, passed: fitnessResult.success, totalChecks: fitnessResult.summary.totalChecks, durationMs: fitnessResult.durationMs });

  return { result, output };
}

/**
 * Best-effort session persistence — invoked when `executeFit` is called
 * with a `datastore` opt. Maps `CliOutput` directly onto the
 * `StoredSession` shape that `SessionRepo` consumes. Errors are caught
 * and logged so a write failure never fails the run; the same policy
 * applied to v1's file-based `saveSession` path.
 */
function persistFitSession(
  datastore: DataStore,
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
  args: CliArgs,
  output: CliOutput,
): void {
  try {
    const repo = new SessionRepo(datastore);
    repo.save({
      id: generatePrefixedId('fit'),
      tool: 'fit',
      timestamp: output.timestamp,
      cwd: args.cwd,
      recipe: output.recipe,
      score: output.score,
      passed: output.passed,
      summary: output.summary,
      checks: output.checks.map((c) => ({
        checkSlug: c.checkSlug,
        passed: c.passed,
        violationCount: c.violationCount,
        findings: c.findings.map((f) => ({
          ruleId: f.ruleId,
          message: f.message,
          severity: f.severity,
          filePath: f.filePath,
          line: f.line,
          column: f.column,
          suggestion: f.suggestion,
        })),
        durationMs: c.durationMs,
      })),
      durationMs: output.durationMs,
    });
  } catch (error) {
    logger.warn({
      evt: 'cli.fit.session.save_failed',
      module: 'cli:fit',
      msg: 'Failed to persist fit session — continuing without history write',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
