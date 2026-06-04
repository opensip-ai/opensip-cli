// @fitness-ignore-file detached-promises -- rebuildDisplayLookups, defaultRegistry.register, and mergeCheckDisplay are synchronous mutators flagged by heuristic
/**
 * Plugin/check discovery + registration for the `fit` command.
 *
 * Owns ALL fit-lifecycle singletons (`checksLoadedFor`,
 * `pluginLoadErrors`, `loadWarnings`, `preLoadHook`) — they are a
 * single unit of state, written exactly once per process by
 * `ensureChecksLoaded()` (or by the CLI bootstrap, in `preLoadHook`'s
 * case) and read by the phase helpers downstream (`buildFitEnvelope`,
 * `buildFitDoneResult`) plus the public `getPluginLoadErrors()` /
 * `getDisplayName()` / `getIcon()` accessors that `FitView` and
 * `dashboard.ts` consume.
 *
 * They are NOT threaded through a `FitContext` parameter today because
 * two external consumers (`FitView` in `opensip-tools`,
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

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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
 * read by `buildFitEnvelope` and `buildFitDoneResult` to fail the run. */
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
  //    ordinary npm dependency declared by opensip-tools and
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
  const { totalRegistered: checksRegistered, warnings: packWarnings, coreMismatchSkips } =
    await loadDiscoveredCheckPackages(discoveryAnchor);
  for (const w of packWarnings) loadWarnings.push(w);

  // 4. No-checks-loaded guard. Silent zero-checks would let a misconfig
  //    or missing dep produce a green run that scanned nothing — the
  //    exact failure mode the CLI exists to prevent. Warn loudly.
  if (checksRegistered === 0) {
    // When the run is empty BECAUSE every candidate pack was refused for a
    // core mismatch, loadDiscoveredCheckPackages already pushed a consolidated
    // warning explaining it and pointing at `pnpm fit`. The generic "install a
    // checks-* package" guidance would be actively misleading there (the packs
    // ARE installed), so only emit it when nothing was skipped for a mismatch.
    if (coreMismatchSkips.length === 0) {
      loadWarnings.push(
        'no check packages were loaded. ' +
          'Install at least one @opensip-tools/checks-* package, ' +
          'or declare plugins.checkPackages in opensip-tools.config.yml.',
      );
    }
    logger.warn({
      evt: 'cli.check_packages.empty',
      module: 'cli:fit',
      msg:
        coreMismatchSkips.length > 0
          ? 'no check packages loaded (all candidates skipped: core mismatch)'
          : 'no check packages loaded',
      coreMismatchSkips: coreMismatchSkips.length,
    });
  }

  rebuildDisplayLookups();
  checksLoadedFor = key;
}

/**
 * Resolve the directory the CLI was installed into, used as a discovery
 * fallback when no projectDir is supplied. Walks up from this module's
 * URL to the opensip-tools package root so node_modules lookup
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
 * The `@opensip-tools/core` module THIS engine resolves — the same core whose
 * `AsyncLocalStorage` `runWithScope` populates. Captured once for comparison
 * against each check pack's resolved core (see {@link foreignCorePath}).
 */
const selfCorePath: string | undefined = (() => {
  try {
    return createRequire(import.meta.url).resolve('@opensip-tools/core');
  } catch {
    /* v8 ignore next 2 -- core is always resolvable from the engine; purely defensive */
    // @fitness-ignore-next-line error-handling-quality -- intentional: an unresolvable core simply disables the single-core guard (fail-open), not an error to log.
    return;
  }
})();

/**
 * Single-core guard. If `packageDir` resolves a DIFFERENT physical
 * `@opensip-tools/core` than this engine, return that foreign core's path;
 * otherwise undefined.
 *
 * A check pack resolving a second core instance registers its checks against
 * a core whose `currentScope()` is always undefined here (a different
 * `AsyncLocalStorage`). That silently degrades content filters to raw and
 * produces false positives — the failure mode seen when a globally-installed
 * CLI discovers check packs in a project that also vendors `@opensip-tools`
 * packages. Such packs are refused at load time rather than run with a broken
 * scope. Packs that don't depend on core at all resolve nothing and are
 * allowed (they can't create a scope-bearing duplicate).
 */
function foreignCorePath(packageDir: string): string | undefined {
  if (selfCorePath === undefined) return undefined;
  try {
    // The anchor file need not exist — createRequire only uses its directory
    // as the resolution base, walking up node_modules from the pack.
    const anchor = pathToFileURL(join(packageDir, 'noop.js')).href;
    const packCore = createRequire(anchor).resolve('@opensip-tools/core');
    return packCore === selfCorePath ? undefined : packCore;
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- resolution probe: a pack that doesn't depend on @opensip-tools/core throws here, and "no foreign core → allow" is the function's contract (mirrors plugins/package-entry.ts).
    return undefined;
  }
}

/** A discovered check package's name + on-disk location. */
interface DiscoveredPack {
  readonly name: string;
  readonly packageDir: string;
}

/**
 * Partition discovered packs into those that share this engine's
 * `@opensip-tools/core` (loadable) and those that resolve a foreign core
 * (refused by the single-core guard, B). Pure — pushes no warnings.
 */
function partitionPacksByCore(packs: readonly DiscoveredPack[]): {
  sameCore: readonly DiscoveredPack[];
  coreMismatchSkips: readonly string[];
  foreignCore: string | undefined;
} {
  const coreMismatchSkips: string[] = [];
  let foreignCore: string | undefined;
  const sameCore = packs.filter((pkg) => {
    const foreign = foreignCorePath(pkg.packageDir);
    if (foreign === undefined) return true;
    coreMismatchSkips.push(pkg.name);
    foreignCore = foreign;
    return false;
  });
  return { sameCore, coreMismatchSkips, foreignCore };
}

/**
 * One consolidated warning naming every core-mismatch skip (rather than a
 * verbose paragraph per pack). Returns `[]` when nothing was skipped, so the
 * caller can spread it unconditionally.
 */
function coreMismatchWarning(skips: readonly string[], foreignCore: string | undefined): string[] {
  if (skips.length === 0) return [];
  return [
    `skipped ${String(skips.length)} check package(s) that resolve a different ` +
      `@opensip-tools/core (${foreignCore ?? '<unknown>'}) than this CLI ` +
      `(${selfCorePath ?? '<unknown>'}): ${skips.join(', ')}. Loading them would split the run ` +
      `scope and produce false positives. Run the project's own CLI instead ` +
      `(e.g. \`pnpm fit\`, or \`npx opensip-tools fit\` from the project).`,
  ];
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
  /**
   * Names of check packs refused by the single-core guard (B). Lets the
   * caller tailor the no-checks-loaded message: when the run is empty BECAUSE
   * packs were skipped for a core mismatch, the generic "install a checks-*
   * package" guidance is misleading (the packs ARE installed).
   */
  readonly coreMismatchSkips: readonly string[];
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
  // Marker-based discovery is the canonical path: any package declaring
  // opensipTools.kind: "fit-pack" is discovered regardless of npm scope. It
  // runs in parallel with the (deprecated) name-pattern walk, which survives
  // only for third-party packs that haven't adopted the marker yet. Dedupe by
  // package name; first occurrence (name-pattern walk) wins so existing
  // customers' telemetry doesn't shift over to a different code path silently.
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

  // Single-core guard (B): drop any pack that resolves a different
  // @opensip-tools/core than this engine BEFORE the load loop (a split run
  // scope would silently degrade content filters to raw → false positives).
  // Partition + warning are extracted to keep this function's control flow flat.
  const { sameCore: sameCorePacks, coreMismatchSkips, foreignCore } = partitionPacksByCore(allPacks);
  warnings.push(...coreMismatchWarning(coreMismatchSkips, foreignCore));

  for (const pkg of sameCorePacks) {
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
  return { totalRegistered, warnings, coreMismatchSkips };
}
