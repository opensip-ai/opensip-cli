// @fitness-ignore-file detached-promises -- rebuildDisplayLookups, register, and mergeCheckDisplay are synchronous mutators flagged by heuristic
/**
 * Plugin/check discovery + registration for the `fit` command.
 *
 * Owns the fit-lifecycle state (`loadedFor`, `pluginLoadErrors`,
 * `loadWarnings`) — a single unit of state, written exactly once per RUN
 * by `ensureChecksLoaded()` and read by the phase helpers downstream
 * (`buildFitEnvelope`, `buildFitDoneResult`) plus the public
 * `getPluginLoadErrors()` / `getDisplayName()` / `getIcon()` accessors
 * that `FitView` and `dashboard.ts` consume.
 *
 * As of the scope-owned-registries refactor (2.10.0) this state lives on
 * the RunScope (`scope.fitness.load`), NOT module singletons — two
 * concurrent fit runs (different scopes) carry independent load state.
 * The accessors read the current scope's slot via
 * `currentFitnessLoadState()`.
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
import {
  currentCheckRegistry,
  currentFitnessLoadState,
  currentRecipeRegistry,
} from '../../framework/scope-registry.js';
import {
  discoverCheckPackages,
  readCheckPackageMetadata,
  readCheckPackagePreferences,
} from '../../plugins/check-package-discovery.js';
import { loadAllPlugins } from '../../plugins/loader.js';

import { mergeCheckDisplay, rebuildDisplayLookups } from './display-registry.js';

// ---------------------------------------------------------------------------
// Public accessors — all read the current RunScope's fitness load state
// (`scope.fitness.load`), set once per run by `ensureChecksLoaded()`.
// ---------------------------------------------------------------------------

/** Warnings collected during the most recent ensureChecksLoaded() call.
 * Returned alongside plugin errors and run-time validation warnings via
 * executeFit's result so the live renderer and JSON output both see them. */
export function getLoadWarnings(): readonly string[] {
  return currentFitnessLoadState().loadWarnings;
}

/**
 * Plugin load errors recorded during the most recent ensureChecksLoaded() call.
 * Read by runFit to fail the run if any plugin failed to import — otherwise a
 * malicious or broken plugin could silently suppress its own checks while the
 * CLI exits 0, masking a compliance failure or a supply-chain compromise.
 */
export function getPluginLoadErrors(): readonly string[] {
  return currentFitnessLoadState().pluginLoadErrors;
}

/** Get the number of enabled checks (available after ensureChecksLoaded). */
export function getEnabledCheckCount(): number {
  return currentCheckRegistry().listEnabled().length;
}

// ---------------------------------------------------------------------------
// Lazy-load fitness checks
// ---------------------------------------------------------------------------

/** Lazily discovers and registers all check packs for the given project
 * (idempotent per project, scoped to the current RunScope). */
export async function ensureChecksLoaded(projectDir?: string): Promise<void> {
  const key = projectDir ?? '';
  // Per-run lifecycle state lives on the scope (`scope.fitness.load`), so
  // two concurrent fit runs (different scopes) load independently.
  const load = currentFitnessLoadState();
  if (load.loadedFor === key) return;

  // Reset per-run warning buffer. Its lifetime mirrors loadedFor —
  // a fresh load (new projectDir or first call) starts with no warnings.
  load.loadWarnings = [];

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
  load.pluginLoadErrors = pluginResult.errors;
  if (pluginResult.errors.length > 0) {
    // Plugin load errors go to loadWarnings (rendered via the result) and
    // logger.warn (structured logs). Direct stderr writes are forbidden
    // during live-view runs — they desync Ink's frame tracking.
    for (const err of pluginResult.errors) {
      load.loadWarnings.push(`plugin failed to load — ${err}`);
      logger.warn({ evt: 'cli.plugin.warning', module: 'cli:fit', message: err });
    }
  }

  // 3. Discover and load fit-pack packages installed in node_modules.
  //    Marker discovery (`opensipTools.kind: "fit-pack"`) is the automatic
  //    path. `plugins.checkPackages` can add exact package names for packs
  //    that do not declare the marker yet.
  //
  //    `projectDir` is the discovery anchor. When called without one (e.g.
  //    ad-hoc `opensip-tools fit` in an unconfigured dir) we fall back to the
  //    CLI's own install dir so the bundled deps still resolve.
  const discoveryAnchor = projectDir ?? cliInstallDir();
  const { totalRegistered: checksRegistered, warnings: packWarnings, coreMismatchSkips } =
    await loadDiscoveredCheckPackages(discoveryAnchor);
  for (const w of packWarnings) load.loadWarnings.push(w);

  // 4. No-checks-loaded guard. Silent zero-checks would let a misconfig
  //    or missing dep produce a green run that scanned nothing — the
  //    exact failure mode the CLI exists to prevent. Warn loudly.
  if (checksRegistered === 0) {
    // When the run is empty BECAUSE every candidate pack was refused for a
    // core mismatch, loadDiscoveredCheckPackages already pushed a consolidated
    // warning explaining it and pointing at `pnpm fit`. The generic "install a
    // fit-pack package" guidance would be actively misleading there (the packs
    // ARE installed), so only emit it when nothing was skipped for a mismatch.
    if (coreMismatchSkips.length === 0) {
      load.loadWarnings.push(
        'no check packages were loaded. ' +
          'Install at least one package declaring opensipTools.kind: "fit-pack", ' +
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
  load.loadedFor = key;
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
   * packs were skipped for a core mismatch, the generic "install a fit-pack
   * package" guidance is misleading (the packs ARE installed).
   */
  readonly coreMismatchSkips: readonly string[];
}

/**
 * Load every marker-discovered or explicitly listed check package. Each
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
  const checkRegistry = currentCheckRegistry();
  const recipeRegistry = currentRecipeRegistry();
  const prefs = readCheckPackagePreferences(projectDir);
  const discovered = discoverCheckPackages({
    projectDir,
    explicitPackages: prefs.checkPackages,
  });
  // Marker-based discovery is the automatic path: any package declaring
  // opensipTools.kind: "fit-pack" is discovered regardless of npm scope. Exact
  // `plugins.checkPackages` entries load alongside it for packages that do not
  // declare the marker yet. Dedupe by package name; explicit config wins.
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
          checkRegistry.register(check, pkg.name);
          registered++;
        }
      }
      totalRegistered += registered;
      mergeCheckDisplay(pkg.name, mod.checkDisplay);
      const { recipesRegistered } = registerRecipesFromMod(mod, recipeRegistry, {
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
