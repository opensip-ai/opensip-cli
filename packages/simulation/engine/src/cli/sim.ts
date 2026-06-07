// @fitness-ignore-file detached-promises -- persistSimSession is a synchronous best-effort SQLite write; heuristic flags it inside the async sim runner
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
 *   1. .mjs plugin discovery via `loadAllSimPlugins(projectDir)`.
 *   2. npm package discovery: `@opensip-tools/scenarios-*` packages
 *      (or anything under `plugins.scenarioPackages` / customer scopes).
 *   3. No-scenarios guard: `executeSim` fails the run closed with a
 *      CONFIGURATION_ERROR (exit 2) when zero scenarios would run,
 *      because a silent green run simulating nothing is the failure mode
 *      the CLI exists to prevent. (The loader only structured-logs the
 *      empty registry; the fatal decision is the command's.)
 */

import { pathToFileURL } from 'node:url';

import { BUILTIN_DEFAULT_RECIPE, buildFindingGroups, buildSignalEnvelope, EXIT_CODES } from '@opensip-tools/contracts';
import { currentScope, discoverPackagesByMarker, logger, registerRecipesFromMod } from '@opensip-tools/core';

import { currentScenarioRegistry } from '../framework/registry.js';
import { loadAllSimPlugins } from '../plugins/loader.js';
import {
  discoverScenarioPackages,
  readScenarioPackageMetadata,
  readScenarioPackagePreferences,
} from '../plugins/scenario-package-discovery.js';
import { currentSimulationRecipeRegistry } from '../recipes/registry.js';
import { SimulationRecipeService } from '../recipes/service.js';

import { resolveSimRecipeSelection } from './sim-config.js';

import type { RunnableScenario } from '../framework/runnable-scenario.js';
import type { SimPluginExports } from '../plugins/types.js';
import type { SimulationScenarioResult } from '../recipes/service.js';
import type { ErrorResult, SimDoneResult, ToolOptions, UnitResult, VerboseDetail } from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';

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
 * Discover and load every sim plugin and scenario package for the
 * project. Idempotent per-projectDir; calling twice with the same
 * directory is a no-op after the first.
 */
export async function ensureScenariosLoaded(projectDir?: string): Promise<void> {
  const key = projectDir ?? '';
  if (scenariosLoadedFor === key) return;

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
  //    scopes are picked up via plugins.packageScopes.
  //
  //    Like fitness's path, projectDir is the discovery anchor; an
  //    ad-hoc invocation without one falls through to no discovery.
  await loadDiscoveredScenarioPackages(projectDir ?? '');

  // 3. No-scenarios guard. Silent zero-scenarios would let a misconfig
  //    or missing dep produce a green run that simulated nothing —
  //    the same failure mode fitness's no-checks guard exists to
  //    prevent.
  if (currentScenarioRegistry().size === 0) {
    // Structured-log only. The user-facing decision — fail the run closed
    // with a CONFIGURATION_ERROR exit so a misconfig/missing-dep can't
    // produce a green run that simulated nothing — is owned by executeSim's
    // zero-scenarios guard (single responsibility: the loader loads, the
    // command decides whether an empty result is fatal).
    logger.warn({
      evt: 'cli.scenario_packages.empty',
      module: 'cli:sim',
      msg: 'no scenarios loaded',
    });
  }

  scenariosLoadedFor = key;
}

/**
 * Lightweight type guard: returns true when `value` has the minimum
 * shape of a `RunnableScenario`. Pulled out of the inner loop so the
 * loadDiscoveredScenarioPackages function stays under the cognitive-
 * complexity limit.
 */
function isRunnableScenarioShape(value: unknown): value is { id: string; kind: string; run: unknown } {
  return value !== null
    && typeof value === 'object'
    && 'id' in value
    && 'kind' in value
    && 'run' in value;
}

/**
 * Register each well-shaped scenario from a discovered scenario
 * package's exported `scenarios` array into the current scope's
 * scenario registry. Per-item failures warn but don't throw — one bad
 * scenario shouldn't disqualify the rest of the package.
 */
function registerScenariosFromMod(
  scenariosField: unknown,
  packageName: string,
): void {
  if (!Array.isArray(scenariosField)) return;
  const registry = currentScenarioRegistry();
  for (const scenario of scenariosField) {
    if (!isRunnableScenarioShape(scenario)) continue;
    try {
      registry.register(scenario as RunnableScenario);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({
        evt: 'cli.scenario_package.scenario_invalid',
        module: 'cli:sim',
        name: packageName,
        error: msg,
      });
    }
  }
}

/**
 * Import every scenario package returned by discoverScenarioPackages().
 * Both scenarios and recipes are explicit array exports — neither
 * registers as a side effect of definition (commit 1a0a71b migrated
 * scenarios; Item 1 migrated recipes). The loader iterates each
 * exported `scenarios` / `recipes` array and registers items into the
 * scope-bound registries.
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
      const scenarioReg = currentScenarioRegistry();
      const sizeBefore = scenarioReg.size;
      const moduleUrl = pathToFileURL(meta.mainEntry).href;
      const mod = (await import(moduleUrl)) as SimPluginExports;
      // Walk the exported scenarios array (defineX no longer
      // self-registers; commit 1a0a71b). registerScenariosFromMod
      // applies the same silent-skip/throw-on-name-collision behavior
      // as the .mjs loader and warns on per-item failures.
      registerScenariosFromMod(mod.scenarios, pkg.name);
      const scenariosRegistered = scenarioReg.size - sizeBefore;
      // Register any explicit recipes via the shared helper. The helper
      // emits the same plugin.recipe.invalid_item warning loader.ts now
      // emits — replaces the previous silent-drop on malformed recipes.
      const { recipesRegistered } = registerRecipesFromMod(mod, currentSimulationRecipeRegistry(), {
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
 * A scenario passes the verdict when it emitted no `critical`/`high` signals
 * AND its own pass/fail verdict held (assertions passed, no thrown error).
 * Mirrors {@link buildSignalEnvelope}'s "no critical/high ⇒ passed" rule and
 * folds in the scenario's assertion verdict (a scenario can fail assertions
 * without emitting a critical/high signal).
 */
function scenarioPassed(scenario: SimulationScenarioResult, signals: readonly Signal[]): boolean {
  const hasErrorSignal = signals.some(
    (s) => s.severity === 'critical' || s.severity === 'high',
  );
  return scenario.passed && !hasErrorSignal;
}

/**
 * Collapse the recipe's per-scenario results into the envelope's two
 * orthogonal carriers (ADR-0011):
 *
 *   - `signals`: the flat run-wide `Signal[]`. Each scenario's signals are
 *     remapped to `source: <scenarioId>` so the shared table formatter
 *     (which groups by `signal.source`) attributes them to the right unit
 *     row even if a scenario authored a divergent `source`.
 *   - `units`: one {@link UnitResult} per scenario (`slug: scenarioId`,
 *     `passed`, `durationMs`, `error?`) — the per-unit ran/errored/timing
 *     facts a flat signal list cannot express.
 *
 * `SimulationMetrics` (load p50/p95/p99) stays a tool-specific artifact on the
 * per-kind `result` and is NOT lifted into the envelope's core shape.
 */
function assembleEnvelopeInputs(
  scenarios: readonly SimulationScenarioResult[],
): { units: UnitResult[]; signals: Signal[] } {
  const units: UnitResult[] = [];
  const signals: Signal[] = [];

  for (const scenario of scenarios) {
    const scenarioSignals = scenario.result?.signals ?? [];
    // Remap source → scenarioId so per-scenario grouping is exact (the
    // unit slug IS the scenarioId, per the migrated-tool contract).
    for (const signal of scenarioSignals) {
      signals.push(signal.source === scenario.scenarioId ? signal : { ...signal, source: scenario.scenarioId });
    }
    units.push({
      slug: scenario.scenarioId,
      passed: scenarioPassed(scenario, scenarioSignals),
      durationMs: scenario.durationMs,
      ...(scenario.error === undefined ? {} : { error: scenario.error }),
    });
  }

  return { units, signals };
}

/** Options for {@link executeSim}. */
export interface ExecuteSimOptions {
  /**
   * Live-progress callback (ADR-0016). Forwarded to the recipe service, which
   * fires `(0, total)` at start and a monotonic `(completed, total)` per
   * scenario. The interactive sim runner maps these to pool ProgressEvents;
   * non-interactive callers (json / non-TTY) omit it.
   */
  readonly onProgress?: (completed: number, total: number) => void;
}

/**
 * Run sim and return a SimDoneResult (or an ErrorResult when the
 * recipe is missing). The caller decides what to print or render.
 */
export async function executeSim(
  args: ToolOptions & { readonly verbose?: boolean },
  opts: ExecuteSimOptions = {},
): Promise<{ result: SimDoneResult | ErrorResult }> {
  // Lifecycle: load .mjs plugins + scenario packages before the recipe
  // registry is read. Idempotent per project dir.
  await ensureScenariosLoaded(args.cwd);

  // Tool-scoped recipe resolution (ADR-0022): explicit --recipe > simulation.recipe
  // > deprecated cli.recipe > built-in default. A config-sourced unknown name
  // tolerantly falls back to `default`; an explicit --recipe typo hard-fails.
  const recipeSelection = resolveSimRecipeSelection(args.cwd, args.recipe);
  let recipeName = recipeSelection.name;
  let recipe = currentSimulationRecipeRegistry().loadRecipe(recipeName);
  if (!recipe && recipeSelection.tolerant && recipeName !== BUILTIN_DEFAULT_RECIPE) {
    logger.warn({
      evt: 'sim.recipe.unknown_config_default',
      module: 'cli:sim',
      requested: recipeName,
      fallback: BUILTIN_DEFAULT_RECIPE,
      msg: `Configured sim recipe '${recipeName}' not found; using '${BUILTIN_DEFAULT_RECIPE}'. If '${recipeName}' is a recipe for another tool, move it under that tool's <tool>.recipe key (ADR-0022).`,
    });
    recipeName = BUILTIN_DEFAULT_RECIPE;
    recipe = currentSimulationRecipeRegistry().loadRecipe(recipeName);
  }
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

  const service = new SimulationRecipeService({ cwd: args.cwd, onProgress: opts.onProgress });
  const recipeResult = await service.runRecipe(recipe);

  const scenarios = recipeResult.scenarios;

  // Fail closed on an empty run. Zero executed scenarios — whether because
  // no scenario packages were loaded at all, or because the recipe selector
  // matched none of the registered scenarios — must NOT report as a pass
  // (exit 0). A green run that simulated nothing is the exact failure mode
  // that masks a misconfig or missing dependency in CI. It is a
  // configuration/unavailable condition (exit 2), distinct from an actual
  // scenario failure (exit 1). Tailor the guidance to the cause.
  if (scenarios.length === 0) {
    const registryEmpty = currentScenarioRegistry().size === 0;
    logger.warn({
      evt: 'cli.sim.empty_run',
      module: 'cli:sim',
      recipeName,
      registryEmpty,
    });
    return {
      result: {
        type: 'error',
        message: registryEmpty
          ? 'No scenarios were loaded — nothing to simulate.'
          : `Recipe '${recipeName}' selected zero scenarios — nothing to simulate.`,
        suggestion: registryEmpty
          ? 'Install at least one @opensip-tools/scenarios-* package, declare plugins.scenarioPackages in opensip-tools.config.yml, or run `opensip-tools init` to scaffold example scenarios.'
          : 'Check the recipe selector — at least one registered scenario must match.',
        exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      },
    };
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

  // ADR-0011: surface every scenario's Signal[] into the one run envelope.
  // `runId`/`createdAt` come off the live scope so cloud egress correlates
  // with the same run id the logger stamps; `currentScope()` is bound for the
  // whole dynamic extent of the action body (enterScope in the pre-action hook).
  const { units, signals } = assembleEnvelopeInputs(scenarios);
  const envelope = buildSignalEnvelope({
    tool: 'sim',
    recipe: recipeName,
    runId: currentScope()?.runId ?? '',
    createdAt: new Date().toISOString(),
    units,
    signals,
  });

  // ADR-0021: on --verbose, carry the per-scenario detail body so the shared
  // resultToView seam renders it identically in a TTY and a pipe. Reuses the
  // shared contracts mapping (sim scenario ids are the unit slugs; identity
  // display name).
  const verboseDetail: VerboseDetail | undefined =
    args.verbose === true
      ? { kind: 'findings', groups: buildFindingGroups(units, signals) }
      : undefined;

  return {
    result: {
      type: 'sim-done',
      recipeName,
      cwd: args.cwd,
      durationMs: recipeResult.durationMs,
      shouldFail: failed > 0,
      envelope,
      ...(verboseDetail === undefined ? {} : { verboseDetail }),
    },
  };
}
