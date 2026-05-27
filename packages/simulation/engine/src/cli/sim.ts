/**
 * sim command — run simulation scenarios via a named recipe.
 *
 * Without `--recipe`, runs the built-in `default` recipe (every
 * registered scenario, parallel mode). With `--recipe <name>`, looks
 * the recipe up in the registry and runs it.
 *
 * Returns a structured `SimDoneResult` with per-scenario outcomes;
 * callers (CLI / Tool layer) render or JSON-serialize as appropriate.
 *
 * Scenario loading lifecycle (mirrors fitness's `ensureChecksLoaded`):
 *
 *   1. Pre-load hook (CLI-injected, e.g. project-plugin auto-sync).
 *   2. .mjs plugin discovery via `loadAllSimPlugins(projectDir)`.
 *   3. npm package discovery: `@opensip-tools/scenarios-*` packages
 *      (or anything under `plugins.scenarioPackages` / customer scopes).
 *   4. No-scenarios guard: warn loudly if zero scenarios registered,
 *      because a silent green run scanning nothing is the failure mode
 *      the CLI exists to prevent.
 */

import { pathToFileURL } from 'node:url';

import { EXIT_CODES } from '@opensip-tools/contracts';
import { discoverPackagesByMarker, logger, registerRecipesFromMod } from '@opensip-tools/core';

import { scenarioRegistry } from '../framework/registry.js';
import { loadAllSimPlugins } from '../plugins/loader.js';
import {
  discoverScenarioPackages,
  readScenarioPackageMetadata,
  readScenarioPackagePreferences,
} from '../plugins/scenario-package-discovery.js';
import { defaultSimulationRecipeRegistry } from '../recipes/registry.js';
import { SimulationRecipeService } from '../recipes/service.js';
import { SCENARIO_KINDS } from '../types/kind-types.js';

import type { SimPluginExports } from '../plugins/types.js';
import type { ScenarioKind } from '../types/kind-types.js';
// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; executeSim consumes the CliArgs shape produced by toolOptsToCliArgs in sim's tool.ts until the rip-out
import type { CliArgs, ErrorResult, SimDoneResult } from '@opensip-tools/contracts';

const VALID_KINDS = new Set<ScenarioKind>(SCENARIO_KINDS);

function isValidKind(value: string): value is ScenarioKind {
  return (VALID_KINDS as Set<string>).has(value);
}

// ---------------------------------------------------------------------------
// Lazy-load simulation scenarios
// ---------------------------------------------------------------------------

/** Project directory for which `ensureScenariosLoaded` has run to completion.
 * Keyed on the directory so a second invocation against a different
 * project (long-lived host, tests, programmatic API) re-loads plugins
 * and scenario packages anchored at the new directory. `null` when no
 * projectDir was supplied; `''` is reserved as the "loaded" sentinel
 * for the no-project case. */
let scenariosLoadedFor: string | null = null;
/** Plugin load failures from the most recent `ensureScenariosLoaded` call —
 * exposed via `getPluginLoadErrors` for callers that want to fail the run. */
let pluginLoadErrors: readonly string[] = [];

/**
 * Plugin load errors recorded during the most recent ensureScenariosLoaded()
 * call. Mirrors fitness's `getPluginLoadErrors` — lets the runner fail the
 * run if any plugin failed to import, so a broken plugin can't silently
 * suppress its own scenarios while the CLI exits 0.
 */
export function getPluginLoadErrors(): readonly string[] {
  return pluginLoadErrors;
}

/**
 * Pre-load hook the CLI registers via setPreLoadHook(). Lets the CLI
 * inject CLI-only behavior (e.g. project-plugin auto-sync) without
 * simulation needing to import CLI internals. Called once before the
 * first ensureScenariosLoaded() in this process.
 */
export type PreLoadHook = (projectDir: string) => Promise<void>;

/** Lifecycle singleton, set by `setPreLoadHook` (called from the CLI
 * bootstrap); read by `ensureScenariosLoaded` once per process. */
let preLoadHook: PreLoadHook | undefined;

/** Register a hook the CLI runs before simulation loads scenarios. */
export function setPreLoadHook(hook: PreLoadHook | undefined): void {
  preLoadHook = hook;
}

/**
 * Discover and load every sim plugin and scenario package for the
 * project. Idempotent per-projectDir; calling twice with the same
 * directory is a no-op after the first.
 */
export async function ensureScenariosLoaded(projectDir?: string): Promise<void> {
  const key = projectDir ?? '';
  if (scenariosLoadedFor === key) return;

  // 0. CLI-injected pre-load hook (auto-sync project plugins, etc).
  //    Skipped when no hook is registered (e.g. running sim via the
  //    Tool API outside the CLI).
  if (projectDir && preLoadHook) {
    await preLoadHook(projectDir);
  }

  // 1. Load sim plugins — discovers .mjs files in
  //    <projectDir>/opensip-tools/sim/{scenarios,recipes}/ and any
  //    npm packages declared in plugins.sim in the project config.
  //    Scenarios self-register on import; recipes register through the
  //    sim loader's registerExports callback.
  const pluginResult = await loadAllSimPlugins(projectDir);
  pluginLoadErrors = pluginResult.errors;
  if (pluginResult.errors.length > 0) {
    for (const err of pluginResult.errors) {
      process.stderr.write(`opensip-tools: plugin failed to load — ${err}\n`);
      logger.warn({ evt: 'cli.plugin.warning', module: 'cli:sim', message: err });
    }
  }

  // 2. Discover and load every @opensip-tools/scenarios-* package
  //    installed in node_modules. No package is privileged. Project
  //    config can override (plugins.scenarioPackages: [...]) or opt
  //    out (plugins.autoDiscoverScenarios: false). Customer-owned
  //    scopes are picked up via plugins.packageScopes (shared with
  //    fitness's check-package discovery).
  //
  //    Like fitness's path, projectDir is the discovery anchor; an
  //    ad-hoc invocation without one falls through to no discovery.
  await loadDiscoveredScenarioPackages(projectDir ?? '');

  // 3. No-scenarios guard. Silent zero-scenarios would let a misconfig
  //    or missing dep produce a green run that simulated nothing —
  //    the same failure mode fitness's no-checks guard exists to
  //    prevent.
  if (scenarioRegistry.size === 0) {
    const msg =
      'opensip-tools: no scenarios were loaded. ' +
      'Install at least one @opensip-tools/scenarios-* package, ' +
      'or declare plugins.scenarioPackages in opensip-tools.config.yml.\n';
    process.stderr.write(msg);
    logger.warn({
      evt: 'cli.scenario_packages.empty',
      module: 'cli:sim',
      msg: 'no scenarios loaded',
    });
  }

  scenariosLoadedFor = key;
}

/**
 * Import every scenario package returned by discoverScenarioPackages().
 * Scenarios self-register at module-import time (via the side effects
 * of `defineLoadScenario`, `defineChaosScenario`, etc.), so importing
 * the entry point is enough — we don't extract a `scenarios` array.
 *
 * Recipes, in contrast, don't self-register, so a `recipes` array on
 * the module is iterated and registered into the sim recipe registry,
 * matching what `registerSimExports` does for .mjs plugins.
 *
 * Errors loading any one package don't fail the others — they surface
 * to stderr the same way sim-domain plugin failures do.
 */
export async function loadDiscoveredScenarioPackages(projectDir: string): Promise<void> {
  if (projectDir === '') return;
  const prefs = readScenarioPackagePreferences(projectDir);
  const discovered = discoverScenarioPackages({
    projectDir,
    explicitPackages: prefs.scenarioPackages,
    autoDiscover: prefs.autoDiscoverScenarios,
    packageScopes: prefs.packageScopes,
  });
  // Marker-based discovery runs in parallel with the name-pattern walk.
  // Customers who declare opensipTools.kind: "sim-pack" in package.json
  // are discovered regardless of npm scope. Dedupe by package name;
  // first occurrence (name-pattern walk) wins.
  const markerDiscovered = discoverPackagesByMarker({ projectDir, kind: 'sim-pack' });
  const seenNames = new Set(discovered.map((p) => p.name));
  const allPacks: readonly { name: string; packageDir: string }[] = [
    ...discovered,
    ...markerDiscovered
      .filter((p) => !seenNames.has(p.name))
      .map((p) => ({ name: p.name, packageDir: p.packageDir })),
  ];
  for (const pkg of allPacks) {
    const meta = readScenarioPackageMetadata(pkg.packageDir);
    if (!meta) {
      process.stderr.write(`opensip-tools: scenario package ${pkg.name} has no readable package.json — skipping\n`);
      continue;
    }
    try {
      const sizeBefore = scenarioRegistry.size;
      const moduleUrl = pathToFileURL(meta.mainEntry).href;
      const mod = (await import(moduleUrl)) as SimPluginExports;
      // Scenarios self-registered on import — measure the delta.
      const scenariosRegistered = scenarioRegistry.size - sizeBefore;
      // Register any explicit recipes via the shared helper. The helper
      // emits the same plugin.recipe.invalid_item warning loader.ts now
      // emits — replaces the previous silent-drop on malformed recipes.
      const { recipesRegistered } = registerRecipesFromMod(mod, defaultSimulationRecipeRegistry, {
        namespace: pkg.name,
        onWarn: (evt, message, extra) => {
          logger.warn({
            evt,
            module: 'cli:sim',
            name: pkg.name,
            msg: message,
            ...extra,
          });
        },
      });
      logger.info({
        evt: 'cli.scenario_package.loaded',
        module: 'cli:sim',
        name: pkg.name,
        scenariosRegistered,
        recipesRegistered,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`opensip-tools: failed to load scenario package ${pkg.name}: ${msg}\n`);
      logger.warn({
        evt: 'cli.scenario_package.load_failed',
        module: 'cli:sim',
        name: pkg.name,
        error: msg,
      });
    }
  }
}

/**
 * Run sim and return a SimDoneResult (or an ErrorResult when the
 * recipe is missing). The caller decides what to print or render.
 */
export async function executeSim(
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
  args: CliArgs,
): Promise<{ result: SimDoneResult | ErrorResult }> {
  // Lifecycle: load .mjs plugins + scenario packages before the recipe
  // registry is read. Idempotent per project dir.
  await ensureScenariosLoaded(args.cwd);

  const recipeName = args.recipe ?? 'default';
  const recipe = defaultSimulationRecipeRegistry.loadRecipe(recipeName);
  if (!recipe) {
    return {
      result: {
        type: 'error',
        message: `Unknown sim recipe '${recipeName}'.`,
        suggestion: 'Run `opensip-tools sim --recipes` to see available recipes.',
        exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      },
    };
  }

  // The `kind` filter, when present, narrows scenarios in addition to
  // the recipe's own selector. Implemented by post-filtering the
  // recipe service's result so the recipe author's intent stays
  // primary and `--kind` is a CLI ergonomics layer on top.
  const service = new SimulationRecipeService({ cwd: args.cwd });
  const recipeResult = await service.runRecipe(recipe);

  let scenarios = recipeResult.scenarios;
  if (args.kind && isValidKind(args.kind)) {
    const kindFilter = args.kind;
    scenarios = scenarios.filter((s) => s.kind === kindFilter);
  }

  const passed = scenarios.filter((s) => s.passed).length;
  const failed = scenarios.length - passed;

  logger.info({
    evt: 'cli.sim.complete',
    module: 'cli:sim',
    recipeName,
    passed,
    failed,
    durationMs: recipeResult.durationMs,
  });

  return {
    result: {
      type: 'sim-done',
      recipeName,
      cwd: args.cwd,
      totalScenarios: scenarios.length,
      passedScenarios: passed,
      failedScenarios: failed,
      scenarios: scenarios.map((s) => ({
        scenarioId: s.scenarioId,
        scenarioName: s.scenarioName,
        kind: s.kind,
        passed: s.passed,
        durationMs: s.durationMs,
        ...(s.error ? { error: s.error } : {}),
      })),
      durationMs: recipeResult.durationMs,
      shouldFail: failed > 0,
    },
  };
}
