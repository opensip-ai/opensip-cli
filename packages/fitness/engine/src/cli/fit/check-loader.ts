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

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentScope, loadCapabilityDomain, logger } from '@opensip-tools/core';

import { currentCheckRegistry, currentFitnessLoadState } from '../../framework/scope-registry.js';
import { readCheckPackagePreferences } from '../../plugins/check-package-discovery.js';
import { loadAllPlugins } from '../../plugins/loader.js';

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
// @fitness-ignore-next-line duplicate-utility-functions -- intentionally parallel per-tool scope accessor: fit reads scope.fitness.load, sim reads scope.simulation.load; they cannot consolidate (different registries) and mirror getLoadWarnings.
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

  // 2. Discover + load fit-pack check packages through the GENERIC capability
  //    substrate (§5.3): marker discovery, the `@opensip-tools` built-in split,
  //    explicit `plugins.checkPackages` (augmented onto markers), and the
  //    single-core guard all live in core now — fitness no longer carries a
  //    bespoke loader. The fit-pack registrar registers each check; co-located
  //    `recipes` route to the fit-recipe domain. Memoized per (domain, project)
  //    on the scope capability registry, so the CLI pre-action hook and this
  //    call don't double-load. Discovery errors (incl. the single-core guard's
  //    foreign-core skips) surface as load warnings.
  for (const err of await loadFitCheckPackages(projectDir ?? cliInstallDir())) {
    load.loadWarnings.push(err);
  }

  // 3. No-checks-loaded guard. Silent zero-checks would let a misconfig or
  //    missing dep produce a green run that scanned nothing — the failure mode
  //    the CLI exists to prevent. Checks the TOTAL registry count (the load may
  //    have been memoized by the pre-action hook, so a per-call delta is wrong).
  if (currentCheckRegistry().listEnabled().length === 0) {
    load.loadWarnings.push(
      'no check packages were loaded. ' +
        'Install at least one package declaring opensipTools.kind: "fit-pack", ' +
        'or declare plugins.checkPackages in opensip-tools.config.yml.',
    );
    logger.warn({
      evt: 'cli.check_packages.empty',
      module: 'cli:fit',
      msg: 'no check packages loaded',
    });
  }

  load.loadedFor = key;
}

/**
 * Drive the generic capability loader for the `fit-pack` domain. Returns any
 * discovery/routing errors (foreign-core skips, load failures) as warning
 * strings. A no-op when the run carries no capability registry (a programmatic
 * fitness use that never wired the host capability plane) or the fit-pack domain
 * is unregistered. Preferences come from fitness's own `plugins.checkPackages`
 * reader — no dependency on `@opensip-tools/config`.
 */
async function loadFitCheckPackages(projectDir: string): Promise<readonly string[]> {
  const registry = currentScope()?.capabilities;
  if (!registry?.hasDomain('fit-pack')) return [];
  const prefs = readCheckPackagePreferences(projectDir);
  const preferences = prefs.checkPackages === undefined ? {} : { packages: prefs.checkPackages };
  return registry.isDomainLoaded('fit-pack', projectDir)
    ? registry.domainLoadErrors('fit-pack')
    : loadCapabilityDomain({
        registry,
        domainId: 'fit-pack',
        projectDir,
        cliDir: cliInstallDir(),
        preferences,
      });
}

/**
 * Resolve the directory the CLI was installed into. Built-in check packs
 * (the @opensip-tools/* fit-packs declared as deps in cli/package.json) always
 * resolve from here, so a globally-installed CLI runs ITS OWN bundled checks at
 * its own version — a project pinning an older @opensip-tools/checks-* cannot
 * shadow them. Also the discovery fallback when no projectDir is supplied.
 * Walks up from this module's URL to the opensip-tools package root so
 * node_modules lookup sees the CLI's own dependency tree.
 */
function cliInstallDir(): string {
  // import.meta.url points at this file inside the CLI's dist/. The CLI
  // package root is two levels up from dist/commands/. Resolve via the
  // Node URL → path bridge to keep this OS-agnostic.
  const thisFile = fileURLToPath(import.meta.url);
  return dirname(dirname(dirname(thisFile)));
}
