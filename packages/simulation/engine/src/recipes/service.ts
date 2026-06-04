// @fitness-ignore-file performance-anti-patterns -- sequential scenario execution preserves ordering and isolates per-scenario state; parallel execution belongs to load-window driver, not the recipe runner
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

import { logger, resolveSelector as resolveSelectorCore, type ResolveSelectorOptions } from '@opensip-tools/core';

import { currentScenarioRegistry } from '../framework/registry.js';

import type { SimulationRecipe, ScenarioSelector } from './types.js';
import type { RunnableScenario } from '../framework/runnable-scenario.js';
import type { ScenarioExecutorResult } from '../framework/scenario-executor-result.js';
import type { ScenarioKind } from '../types/kind-types.js';

/** Optional narrowing applied to the recipe-selected scenarios before they run. */
export interface RunRecipeOptions {
  /**
   * Restrict execution to a single scenario kind (the `--kind` CLI flag).
   * Applied to the recipe-selected set BEFORE execution, so scenarios of
   * other kinds — which may have real side effects (load, chaos) — are never
   * run, only to be hidden from the output afterward.
   */
  readonly kindFilter?: ScenarioKind;
}

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
  async runRecipe(
    recipe: SimulationRecipe,
    options: RunRecipeOptions = {},
  ): Promise<SimulationRecipeResult> {
    const startedAt = Date.now();
    const matched = resolveSelector(recipe.scenarios);
    // `--kind` narrows the recipe-selected set BEFORE execution. Previously the
    // CLI ran every recipe-selected scenario and post-filtered the results,
    // which meant a `--kind invariant` run still executed load/chaos scenarios
    // (with their side effects) and merely hid them. Filter first, run second.
    const selected = options.kindFilter
      ? matched.filter((s) => s.kind === options.kindFilter)
      : matched;

    logger.info({
      evt: 'simulation.recipe.start',
      module: 'simulation:recipes',
      recipeName: recipe.name,
      scenarioCount: selected.length,
    });

    const results = recipe.execution.mode === 'parallel'
      ? await runParallel(selected, recipe, this.config.abortSignal)
      : await runSequential(selected, recipe, this.config.abortSignal);

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
  const all = currentScenarioRegistry().getAll();

  // Sim's selection semantics are id/name-literal everywhere (no glob, no
  // per-unit config) and its `tags`/`kind` exclude on id/name rather than
  // tags — all of which differ from core's tag/glob built-in arms. So sim
  // supplies a predicate for every arm; core's role is the generic
  // `items.filter(predicate)` dispatch plus the exhaustive-unknown guard,
  // and it never has to name `ScenarioKind`. Registration order is preserved
  // by `filter`, matching the previous hand-rolled switch byte-for-byte.
  const opts: ResolveSelectorOptions<RunnableScenario, ScenarioSelector> = {
    keysOf: (s) => [s.id, s.name],
    tagsOf: (s) => s.tags,
    predicates: {
      all: (s, sel) => {
        if (sel.type !== 'all') return false;
        const exclude = new Set(sel.exclude);
        return !exclude.has(s.id) && !exclude.has(s.name);
      },
      explicit: (s, sel) => {
        if (sel.type !== 'explicit') return false;
        const wanted = new Set(sel.scenarioIds);
        return wanted.has(s.id) || wanted.has(s.name);
      },
      tags: (s, sel) => {
        if (sel.type !== 'tags') return false;
        const include = new Set(sel.include);
        const exclude = new Set(sel.exclude);
        return s.tags.some((t) => include.has(t)) && !exclude.has(s.id) && !exclude.has(s.name);
      },
      kind: (s, sel) => {
        if (sel.type !== 'kind') return false;
        const kinds = new Set(sel.kinds);
        const exclude = new Set(sel.exclude);
        return kinds.has(s.kind) && !exclude.has(s.id) && !exclude.has(s.name);
      },
    },
  };

  return resolveSelectorCore(selector, all, opts);
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
      // Propagate the executor's pass/fail verdict (computed from
      // assertions or kind-specific predicates). A scenario whose run
      // completed without throwing can still have failing assertions.
      passed: result.passed,
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
  recipe: SimulationRecipe,
  abortSignal?: AbortSignal,
): Promise<readonly SimulationScenarioResult[]> {
  const limit = recipe.execution.maxParallel;
  // No bound configured (or a bound at/above the set size) → run them all at
  // once, the historical behavior. A positive `maxParallel` caps the number of
  // scenarios in flight via a fixed worker pool, honoring the recipe's
  // declared concurrency ceiling (previously this option was ignored).
  if (limit === undefined || limit <= 0 || limit >= scenarios.length) {
    return Promise.all(scenarios.map((s) => runSingle(s, abortSignal)));
  }

  const results: SimulationScenarioResult[] = [];
  let next = 0;
  // `next++` is atomic in single-threaded JS, so each worker claims a distinct
  // index; results are written by index to preserve scenario order.
  const worker = async (): Promise<void> => {
    for (let i = next++; i < scenarios.length; i = next++) {
      results[i] = await runSingle(scenarios[i], abortSignal);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
