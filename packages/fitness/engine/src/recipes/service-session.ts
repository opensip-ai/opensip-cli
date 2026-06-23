/**
 * @fileoverview Session lifecycle helpers for fitness recipe execution
 *
 * Creates session state, collects applied directives, and builds recipe results.
 */

import { passRate } from '@opensip-cli/contracts';

import type { DirectiveEntry } from '../framework/directive-inventory.js';
import type { FitnessRecipeSession } from './service-types.js';
import type { FitnessRecipe, FitnessRecipeResult, RecipeRunSummary } from './types.js';

/** Default success threshold percentage when none is configured. */
export const DEFAULT_SUCCESS_THRESHOLD_PERCENT = 85;

/** Create initial mutable session state for a recipe run. */
export function createRecipeSession(
  sessionId: string,
  recipe: FitnessRecipe,
): FitnessRecipeSession {
  return {
    sessionId,
    recipe,
    startedAt: new Date(),
    status: 'running',
    totalChecks: 0,
    completedChecks: 0,
    passedChecks: 0,
    failedChecks: 0,
    totalErrors: 0,
    totalWarnings: 0,
    totalIgnored: 0,
    ignoresByTag: new Map(),
    checkResults: [],
    directives: [],
  };
}

/** Flatten applied directives from all check results in the session. */
export function collectAppliedDirectives(session: FitnessRecipeSession | null): DirectiveEntry[] {
  const result: DirectiveEntry[] = [];
  if (!session) return result;
  for (const cr of session.checkResults) {
    if (cr.appliedDirectives) {
      for (const directive of cr.appliedDirectives) {
        result.push(directive);
      }
    }
  }
  return result;
}

/** Build the final {@link FitnessRecipeResult} from completed session state. */
export function buildRecipeResult(session: FitnessRecipeSession): FitnessRecipeResult {
  const completedAt = new Date();

  const summary: RecipeRunSummary = {
    totalChecks: session.totalChecks,
    passedChecks: session.passedChecks,
    failedChecks: session.failedChecks,
    skippedChecks: session.totalChecks - session.completedChecks,
    erroredChecks: session.checkResults.filter((r) => r.error !== undefined).length,
    totalViolations: session.checkResults.reduce((sum, r) => sum + r.violationCount, 0),
    totalErrors: session.totalErrors,
    totalWarnings: session.totalWarnings,
    totalIgnored: session.totalIgnored,
  };

  const score = passRate({
    total: session.totalChecks,
    passed: session.passedChecks,
  });

  const result: FitnessRecipeResult = {
    recipeId: session.recipe.id,
    recipeName: session.recipe.name,
    sessionId: session.sessionId,
    success:
      score >= (session.recipe.execution.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD_PERCENT) &&
      session.status === 'completed',
    startedAt: session.startedAt,
    completedAt,
    durationMs: completedAt.getTime() - session.startedAt.getTime(),
    checkResults: session.checkResults,
    summary,
  };

  return {
    ...result,
    ...(session.ignoreCounts ? { ignoreCounts: session.ignoreCounts } : {}),
    ...(session.directives.length > 0 ? { directives: session.directives } : {}),
  };
}