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

import {
  logger,
  resolveSelector as resolveSelectorCore,
  runWithTimeout,
  scheduleUnits,
  type ResolveSelectorOptions,
} from '@opensip-tools/core';

import { currentScenarioRegistry } from '../framework/registry.js';

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
  /**
   * Optional live-progress callback (ADR-0016). Fired once with `(0, total)`
   * before execution and then with a monotonic `(completed, total)` after each
   * scenario finishes — across BOTH sequential and parallel modes. `total` is
   * the recipe-selected set size. Count-shaped (not a renderer event)
   * so the engine stays UI-agnostic; the sim runner maps it to ProgressEvents.
   */
  readonly onProgress?: (completed: number, total: number) => void;
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
  ): Promise<SimulationRecipeResult> {
    const startedAt = Date.now();
    const selected = resolveSelector(recipe.scenarios);

    logger.info({
      evt: 'simulation.recipe.start',
      module: 'simulation:recipes',
      recipeName: recipe.name,
      scenarioCount: selected.length,
    });

    // Live-progress (ADR-0016): emit a monotonic completed count across both
    // execution modes. `++completed` is atomic in single-threaded JS, so the
    // parallel pool's concurrent completions still produce a correct count.
    const total = selected.length;
    let completed = 0;
    const { onProgress } = this.config;
    onProgress?.(0, total);
    const onComplete = onProgress
      ? (): void => {
          completed += 1;
          onProgress(completed, total);
        }
      : undefined;

    const results = await runScenarios(selected, recipe, this.config.abortSignal, onComplete);

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
// EXECUTION (on the shared substrate, release 2.13.0 §5.8)
// =============================================================================

/**
 * Sentinel timeout (the max `setTimeout` delay, ~24.8 days) used when a recipe
 * declares no `execution.timeout` — preserving sim's historical "no timeout"
 * behaviour while routing through the same substrate. A DECLARED timeout is
 * enforced and aborts a runaway scenario (the §4.3 fix; previously the field was
 * silently ignored).
 */
const NO_TIMEOUT_MS = 2_147_483_647;

/** Effective concurrency: a positive bound below the set size, else run all at once. */
function effectiveMaxParallel(recipe: SimulationRecipe, count: number): number {
  const limit = recipe.execution.maxParallel;
  return limit !== undefined && limit > 0 && limit < count ? limit : count;
}

/**
 * Run one scenario on the substrate: a declared `timeout` aborts a runaway run,
 * and the timeout's signal is combined with the service-level abort so external
 * cancellation still reaches an in-flight scenario. Maps the classified outcome to
 * a `SimulationScenarioResult` — a timed-out scenario fails (it did not pass),
 * exactly as a thrown error does.
 */
async function runScenarioUnit(
  scenario: RunnableScenario,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<SimulationScenarioResult> {
  const outcome = await runWithTimeout({
    run: (timeoutSignal) =>
      scenario.run(abortSignal ? AbortSignal.any([timeoutSignal, abortSignal]) : timeoutSignal),
    timeoutMs,
  });

  const base = {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    kind: scenario.kind,
    durationMs: outcome.durationMs,
  };

  if (outcome.status === 'ok') {
    // Propagate the executor's pass/fail verdict (assertions / kind predicates):
    // a run that completed without throwing can still have failing assertions.
    return { ...base, passed: outcome.result.passed, result: outcome.result };
  }

  let message: string;
  if (outcome.status === 'timeout') {
    message = `Scenario timed out after ${outcome.timeoutMs}ms`;
  } else {
    message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
  }
  logger.warn({
    evt: 'simulation.scenario.failed',
    module: 'simulation:recipes',
    scenarioId: scenario.id,
    error: message,
    timedOut: outcome.status === 'timeout',
  });
  return { ...base, passed: false, error: message };
}

/**
 * Run the selected scenarios through the shared scheduler (one loop for both
 * modes). `maxParallel`/`stopOnFirstFailure` now mean the same thing they do in
 * fitness — parallel mode honours `stopOnFirstFailure` (it previously ignored it).
 * Results are written by array index so order is preserved across both modes.
 */
async function runScenarios(
  scenarios: readonly RunnableScenario[],
  recipe: SimulationRecipe,
  abortSignal?: AbortSignal,
  onComplete?: () => void,
): Promise<readonly SimulationScenarioResult[]> {
  const timeoutMs = recipe.execution.timeout ?? NO_TIMEOUT_MS;
  const results: (SimulationScenarioResult | undefined)[] = [];

  await scheduleUnits<RunnableScenario>({
    units: scenarios,
    mode: recipe.execution.mode,
    maxParallel: effectiveMaxParallel(recipe, scenarios.length),
    // Interim live-view smoothing (ADR-0028) — paint between scenarios on the
    // in-process path; superseded for the live run by off-main-thread execution.
    yieldBetweenUnits: true,
    shouldAbort: () => abortSignal?.aborted === true,
    runUnit: async (scenario, index) => {
      const result = await runScenarioUnit(scenario, timeoutMs, abortSignal);
      results[index] = result;
      onComplete?.();
      return { shouldStop: !result.passed && recipe.execution.stopOnFirstFailure === true };
    },
  });

  return results.filter((r): r is SimulationScenarioResult => r !== undefined);
}
