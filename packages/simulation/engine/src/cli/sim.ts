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

import {
  BUILTIN_DEFAULT_RECIPE,
  buildFindingGroups,
  buildSignalEnvelope,
  EXIT_CODES,
} from '@opensip-tools/contracts';
import {
  currentScope,
  generatePrefixedId,
  loadCapabilityDomain,
  logger,
  resolveScopes,
  resolveVerdictPolicy,
} from '@opensip-tools/core';
import { SessionRepo } from '@opensip-tools/session-store';

import { currentScenarioRegistry, currentSimulationLoadState } from '../framework/registry.js';
import { buildSimulationSessionPayload } from '../persistence/session-payload.js';
import { loadAllSimPlugins } from '../plugins/loader.js';
import { readScenarioPackagePreferences } from '../plugins/scenario-package-discovery.js';
import { currentSimulationRecipeRegistry } from '../recipes/registry.js';
import { SimulationRecipeService } from '../recipes/service.js';

import { resolveSimRecipeSelection } from './sim-config.js';

import type { SimulationScenarioResult } from '../recipes/service.js';
import type {
  ErrorResult,
  SimDoneResult,
  ToolOptions,
  UnitResult,
  VerboseDetail,
} from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

// ---------------------------------------------------------------------------
// Lazy-load simulation scenarios
// ---------------------------------------------------------------------------

/**
 * Plugin load errors recorded during the most recent ensureScenariosLoaded()
 * call — on `scope.simulation.load` now, NOT a module singleton (audit F1). Read
 * by the runner to fail the run if a broken plugin silently suppressed its
 * scenarios while the CLI exits 0.
 */
export function getPluginLoadErrors(): readonly string[] {
  return currentSimulationLoadState().pluginLoadErrors;
}

/**
 * Discover and load every sim plugin and scenario package for the project.
 * Idempotent per-projectDir, memoized on `scope.simulation.load` (audit F1).
 */
export async function ensureScenariosLoaded(projectDir?: string): Promise<void> {
  const key = projectDir ?? '';
  const load = currentSimulationLoadState();
  if (load.loadedFor === key) return;

  // 1. Load .mjs sim plugins — project-local scenarios/recipes + plugins.sim
  //    packages. Scenarios self-register on import; recipes via the loader.
  const pluginResult = await loadAllSimPlugins(projectDir);
  load.pluginLoadErrors = pluginResult.errors;
  for (const err of pluginResult.errors) {
    process.stderr.write(`opensip-tools: plugin failed to load — ${err}\n`);
    logger.warn({ evt: 'cli.plugin.warning', module: 'cli:sim', message: err });
  }

  // 2. Scenario packages (+ co-located recipes → the sim-recipe domain) through
  //    the GENERIC capability substrate (§5.3): name-pattern `<scope>/scenarios-*`
  //    discovery, the documented plugins.{scenarioPackages,autoDiscoverScenarios,
  //    packageScopes} keys, and the single-core guard all live in core now — sim
  //    no longer carries a bespoke loader. Memoized per (domain, project) on the
  //    scope capability registry, so the CLI pre-action hook and this don't
  //    double-load.
  await loadSimScenarioPackages(projectDir ?? '');

  // 3. No-scenarios guard (structured-log only; executeSim owns the fatal exit).
  if (currentScenarioRegistry().size === 0) {
    logger.warn({
      evt: 'cli.scenario_packages.empty',
      module: 'cli:sim',
      msg: 'no scenarios loaded',
    });
  }

  load.loadedFor = key;
}

/**
 * Drive the generic capability loader for the `sim-pack` domain. A no-op when the
 * run carries no capability registry (a programmatic sim use that never wired the
 * host capability plane), the domain is unregistered, or no projectDir. Scopes are
 * merged (default `@opensip-tools` ∪ customer `packageScopes`) here so name-pattern
 * discovery matches the prior `resolveScopes` behavior. No `@opensip-tools/config` dep.
 */
async function loadSimScenarioPackages(projectDir: string): Promise<void> {
  if (projectDir === '') return;
  const registry = currentScope()?.capabilities;
  if (!registry?.hasDomain('sim-pack') || registry.isDomainLoaded('sim-pack', projectDir)) return;
  const prefs = readScenarioPackagePreferences(projectDir);
  const scopes = resolveScopes(
    '@opensip-tools',
    prefs.packageScopes ?? [],
    'plugin.scenario_package.invalid_scope',
  );
  const preferences = {
    ...(prefs.scenarioPackages === undefined ? {} : { packages: prefs.scenarioPackages }),
    ...(prefs.autoDiscoverScenarios === undefined
      ? {}
      : { autoDiscover: prefs.autoDiscoverScenarios }),
    scopes,
  };
  await loadCapabilityDomain({ registry, domainId: 'sim-pack', projectDir, preferences });
}

/**
 * A scenario passes the verdict when it emitted no `critical`/`high` signals
 * AND its own pass/fail verdict held (assertions passed, no thrown error).
 * Mirrors {@link buildSignalEnvelope}'s "no critical/high ⇒ passed" rule and
 * folds in the scenario's assertion verdict (a scenario can fail assertions
 * without emitting a critical/high signal).
 */
function scenarioPassed(scenario: SimulationScenarioResult, signals: readonly Signal[]): boolean {
  const hasErrorSignal = signals.some((s) => s.severity === 'critical' || s.severity === 'high');
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
function assembleEnvelopeInputs(scenarios: readonly SimulationScenarioResult[]): {
  units: UnitResult[];
  signals: Signal[];
} {
  const units: UnitResult[] = [];
  const signals: Signal[] = [];

  for (const scenario of scenarios) {
    const scenarioSignals = scenario.result?.signals ?? [];
    // Remap source → scenarioId so per-scenario grouping is exact (the
    // unit slug IS the scenarioId, per the migrated-tool contract).
    for (const signal of scenarioSignals) {
      signals.push(
        signal.source === scenario.scenarioId ? signal : { ...signal, source: scenario.scenarioId },
      );
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

  // Tool-scoped recipe resolution (ADR-0022): explicit --recipe >
  // simulation.recipe > built-in default. A config-sourced unknown name
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
    // ADR-0035: sim declares no failOn* keys, so it inherits the host fallback
    // {1,0}. With Phase 0 (a failed scenario emits an error signal), this
    // reproduces sim's historical `failed > 0` exit exactly. Scenario throws land
    // in UnitResult.error (a unit fault), so runFaulted stays false here.
    policy: resolveVerdictPolicy('simulation'),
    runFaulted: false,
  });

  // ADR-0021: on --verbose, carry the per-scenario detail body so the shared
  // resultToView seam renders it identically in a TTY and a pipe. Reuses the
  // shared contracts mapping (sim scenario ids are the unit slugs; identity
  // display name).
  const verboseDetail: VerboseDetail | undefined =
    args.verbose === true
      ? { kind: 'findings', groups: buildFindingGroups(units, signals) }
      : undefined;

  const result: SimDoneResult = {
    type: 'sim-done',
    recipeName,
    cwd: args.cwd,
    durationMs: recipeResult.durationMs,
    // ADR-0035: the run verdict is the single host verdict. With Phase 0 a failed
    // scenario emits an error signal, so `envelope.verdict.passed` (with the {1,0}
    // policy) is exactly the old `failed > 0`; the host derives the exit from it.
    envelope,
    ...(verboseDetail === undefined ? {} : { verboseDetail }),
  };
  // Persistence is the CALLER's job (ADR-0028 — worker-safe engine): the engine
  // returns the result and the caller persists on the main thread via
  // `persistSimSession` (the datastore handle cannot cross the worker boundary).
  return { result };
}

/** Persist a completed sim run. Best-effort — a SQLite write failure never fails
 *  an otherwise-successful run. Called by the run-mode callers on the main thread. */
export function persistSimSession(datastore: DataStore, result: SimDoneResult): void {
  try {
    const repo = new SessionRepo(datastore);
    repo.save({
      id: generatePrefixedId('sim'),
      tool: 'sim',
      timestamp: result.envelope.createdAt,
      cwd: result.cwd,
      recipe: result.recipeName,
      score: result.envelope.verdict.score,
      passed: result.envelope.verdict.passed,
      durationMs: result.durationMs,
      payload: buildSimulationSessionPayload(result.envelope),
    });
  } catch (error) {
    logger.warn({
      evt: 'cli.sim.session.save_failed',
      module: 'cli:sim',
      msg: 'Failed to persist sim session — continuing without history write',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
