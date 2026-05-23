/**
 * sim command — run simulation scenarios via a named recipe.
 *
 * Without `--recipe`, runs the built-in `default` recipe (every
 * registered scenario, parallel mode). With `--recipe <name>`, looks
 * the recipe up in the registry and runs it.
 *
 * Returns a structured `SimDoneResult` with per-scenario outcomes;
 * callers (CLI / Tool layer) render or JSON-serialize as appropriate.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';
import { logger } from '@opensip-tools/core';

import { defaultSimulationRecipeRegistry } from '../recipes/registry.js';
import { SimulationRecipeService } from '../recipes/service.js';

// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; executeSim consumes the CliArgs shape produced by toolOptsToCliArgs in sim's tool.ts until the rip-out
import type { CliArgs, ErrorResult, SimDoneResult } from '@opensip-tools/contracts';

const VALID_KINDS = new Set(['load', 'chaos', 'invariant', 'fix-evaluation']);

/**
 * Run sim and return a SimDoneResult (or an ErrorResult when the
 * recipe is missing). The caller decides what to print or render.
 */
export async function executeSim(
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
  args: CliArgs,
): Promise<{ result: SimDoneResult | ErrorResult }> {
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
  if (args.kind && VALID_KINDS.has(args.kind)) {
    scenarios = scenarios.filter((s) => s.kind === args.kind);
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
