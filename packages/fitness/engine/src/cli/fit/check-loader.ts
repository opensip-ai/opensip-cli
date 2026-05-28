// @fitness-ignore-file detached-promises -- rebuildDisplayLookups, defaultRegistry.register, and mergeCheckDisplay are synchronous mutators flagged by heuristic
/**
 * Plugin/check discovery + registration for the `fit` command.
 *
 * Owns ALL fit-lifecycle singletons (`checksLoadedFor`,
 * `pluginLoadErrors`, `loadWarnings`, `preLoadHook`) — they are a
 * single unit of state, written exactly once per process by
 * `ensureChecksLoaded()` (or by the CLI bootstrap, in `preLoadHook`'s
 * case) and read by the phase helpers downstream (`buildCliOutput`,
 * `buildFitDoneResult`) plus the public `getPluginLoadErrors()` /
 * `getDisplayName()` / `getIcon()` accessors that `FitView` and
 * `dashboard.ts` consume.
 *
 * They are NOT threaded through a `FitContext` parameter today because
 * two external consumers (`FitView` in `@opensip-tools/cli`,
 * `dashboard.ts` in this package) reach for the accessors directly —
 * wiring everything through a context object would either break those
 * imports or maintain a dual access path. Audit 2026-05-23 F6 documents
 * the trade-off; revisit when multi-instance fitness in one process
 * becomes a contract decision (prior Finding #10).
 *
 * Invariant: each binding is set by `ensureChecksLoaded()` and read by
 * the phase helpers; `executeFit`'s phase ordering is sequenced so the
 * readers always run after the setter completes.
 */

import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  discoverPackagesByMarker,
  logger,
  registerRecipesFromMod,
} from '@opensip-tools/core';

import { isCheck } from '../../framework/check-types.js';
import { defaultRegistry } from '../../framework/registry.js';
import {
  discoverCheckPackages,
  readCheckPackageMetadata,
  readCheckPackagePreferences,
} from '../../plugins/check-package-discovery.js';
import { loadAllPlugins } from '../../plugins/loader.js';
import { defaultRecipeRegistry } from '../../recipes/registry.js';

import { mergeCheckDisplay, rebuildDisplayLookups } from './display-registry.js';

// ---------------------------------------------------------------------------
// Lifecycle singletons (see file header for rationale)
// ---------------------------------------------------------------------------

/** Project directory for which `ensureChecksLoaded` has run to completion.
 * Keyed on the directory so a second invocation against a different
 * project (long-lived host, tests, programmatic API) re-loads plugins
 * and check packages anchored at the new directory. `null` when no
 * projectDir was supplied; `''` is reserved as the "loaded" sentinel
 * for the no-project case. */
let checksLoadedFor: string | null = null;

/** Plugin load failures from the most recent `ensureChecksLoaded` call —
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

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

/** Warnings collected during the most recent ensureChecksLoaded() call.
 * Returned alongside plugin errors and run-time validation warnings via
 * executeFit's result so the live renderer and JSON output both see them. */
export function getLoadWarnings(): readonly string[] {
  return loadWarnings;
}

/**
 * Plugin load errors recorded during the most recent ensureChecksLoaded() call.
 * Read by runFit to fail the run if any plugin failed to import — otherwise a
 * malicious or broken plugin could silently suppress its own checks while the
 * CLI exits 0, masking a compliance failure or a supply-chain compromise.
 */
export function getPluginLoadErrors(): readonly string[] {
  return pluginLoadErrors;
}

/** Register a hook the CLI runs before fitness loads checks. */
export function setPreLoadHook(hook: PreLoadHook | undefined): void {
  preLoadHook = hook;
}

/** Get the number of enabled checks (available after ensureChecksLoaded). */
export function getEnabledCheckCount(): number {
  return defaultRegistry.listEnabled().length;
}

// ---------------------------------------------------------------------------
// Lazy-load fitness checks
// ---------------------------------------------------------------------------

/** Lazily discovers and registers all check packs for the given project (idempotent per project). */
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
