/**
 * @fileoverview SimulationRecipeService — resolves a recipe to scenarios
 * and runs them.
 *
 * The fitness recipe service is a much heavier orchestrator (file
 * cache, AST parse cache, parallel scheduler, retry, callbacks). Sim
 * doesn't have that surface yet — scenarios are self-contained and
 * cheap. This service is intentionally minimal: pick scenarios, run
 * them in the requested mode, return a result.
 *
 * Scope is the recipe-driven path. Direct `runScenario(scenario)`
 * still exists in framework/ for callers that already have a
 * RunnableScenario; recipes layer above that.
 */

import { logger } from '@opensip-tools/core';

import { scenarioRegistry } from '../framework/registry.js';

import type { SimulationRecipe, ScenarioSelector } from './types.js';
import type { RunnableScenario } from '../framework/runnable-scenario.js';
import type { ScenarioExecutorResult } from '../framework/scenario-executor-result.js';

/** Per-scenario outcome inside a recipe run. */
export interface SimulationScenarioResult {
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly kind: RunnableScenario['kind'];
  readonly passed: boolean;
  readonly durationMs: number;
  readonly error?: string;
  readonly result?: ScenarioExecutorResult;
}

/** Aggregate result of running a recipe. */
export interface SimulationRecipeResult {
  readonly recipeName: string;
  readonly recipeId: string;
  readonly totalScenarios: number;
  readonly passedScenarios: number;
  readonly failedScenarios: number;
  readonly scenarios: readonly SimulationScenarioResult[];
  readonly durationMs: number;
}

export interface SimulationRecipeServiceConfig {
  readonly cwd?: string;
  readonly abortSignal?: AbortSignal;
}

export class SimulationRecipeService {
  private readonly config: SimulationRecipeServiceConfig;

  constructor(config: SimulationRecipeServiceConfig = {}) {
    this.config = config;
  }

  /**
   * Run a recipe by resolving its scenario selector against the live
   * scenario registry and executing the matched set.
   */
  async runRecipe(recipe: SimulationRecipe): Promise<SimulationRecipeResult> {
    const startedAt = Date.now();
    const matched = resolveSelector(recipe.scenarios);

    logger.info({
      evt: 'simulation.recipe.start',
      module: 'simulation:recipes',
      recipeName: recipe.name,
      scenarioCount: matched.length,
    });

    const results = recipe.execution.mode === 'parallel'
      ? await runParallel(matched, recipe, this.config.abortSignal)
      : await runSequential(matched, recipe, this.config.abortSignal);

    const passedCount = results.filter((r) => r.passed).length;
    const out: SimulationRecipeResult = {
      recipeName: recipe.name,
      recipeId: recipe.id,
      totalScenarios: results.length,
      passedScenarios: passedCount,
      failedScenarios: results.length - passedCount,
      scenarios: results,
      durationMs: Date.now() - startedAt,
    };

    logger.info({
      evt: 'simulation.recipe.complete',
      module: 'simulation:recipes',
      recipeName: recipe.name,
      passed: passedCount,
      failed: results.length - passedCount,
      durationMs: out.durationMs,
    });

    return out;
  }
}

// =============================================================================
// SELECTOR RESOLUTION
// =============================================================================

/**
 * Materialize a scenario selector against the registered scenarios.
 *
 * Returns the unique set of `RunnableScenario` objects matching the
 * selector. Order is the registration order from the registry.
 */
function resolveSelector(selector: ScenarioSelector): readonly RunnableScenario[] {
  const all = scenarioRegistry.getAll();

  switch (selector.type) {
    case 'all': {
      const exclude = new Set(selector.exclude);
      return all.filter((s) => !exclude.has(s.id) && !exclude.has(s.name));
    }
    case 'explicit': {
      const wanted = new Set(selector.scenarioIds);
      return all.filter((s) => wanted.has(s.id) || wanted.has(s.name));
    }
    case 'tags': {
      const include = new Set(selector.include);
      const exclude = new Set(selector.exclude);
      return all.filter(
        (s) =>
          s.tags.some((t) => include.has(t)) &&
          !exclude.has(s.id) &&
          !exclude.has(s.name),
      );
    }
    case 'kind': {
      const kinds = new Set(selector.kinds);
      const exclude = new Set(selector.exclude);
      return all.filter(
        (s) => kinds.has(s.kind) && !exclude.has(s.id) && !exclude.has(s.name),
      );
    }
  }
}

// =============================================================================
// EXECUTION MODES
// =============================================================================

async function runSingle(
  scenario: RunnableScenario,
  abortSignal?: AbortSignal,
): Promise<SimulationScenarioResult> {
  const started = Date.now();
  const signal = abortSignal ?? new AbortController().signal;
  try {
    const result = await scenario.run(signal);
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      kind: scenario.kind,
      passed: true,
      durationMs: Date.now() - started,
      result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({
      evt: 'simulation.scenario.failed',
      module: 'simulation:recipes',
      scenarioId: scenario.id,
      error: message,
    });
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      kind: scenario.kind,
      passed: false,
      durationMs: Date.now() - started,
      error: message,
    };
  }
}

async function runSequential(
  scenarios: readonly RunnableScenario[],
  recipe: SimulationRecipe,
  abortSignal?: AbortSignal,
): Promise<readonly SimulationScenarioResult[]> {
  const out: SimulationScenarioResult[] = [];
  for (const scenario of scenarios) {
    if (abortSignal?.aborted) break;
    const result = await runSingle(scenario, abortSignal);
    out.push(result);
    if (!result.passed && recipe.execution.stopOnFirstFailure === true) break;
  }
  return out;
}

async function runParallel(
  scenarios: readonly RunnableScenario[],
  _recipe: SimulationRecipe,
  abortSignal?: AbortSignal,
): Promise<readonly SimulationScenarioResult[]> {
  // Sim's parallel mode is unbounded today — scenarios are cheap and
  // there's no global resource (file cache, parse cache) to throttle
  // around. If maxParallel becomes important, slot a p-limit here.
  return Promise.all(scenarios.map((s) => runSingle(s, abortSignal)));
}
