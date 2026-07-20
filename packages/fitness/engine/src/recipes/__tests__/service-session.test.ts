import { describe, expect, it } from 'vitest';

import { buildRecipeResult, createRecipeSession } from '../service-session.js';

import type { FitnessRecipe, RecipeCheckResult } from '../types.js';

const recipe: FitnessRecipe = {
  id: 'RCP_service-session',
  name: 'service-session',
  displayName: 'Service session',
  description: 'test recipe',
  checks: { type: 'all' },
  execution: {
    mode: 'sequential',
    stopOnFirstFailure: false,
    successThreshold: 0,
  },
  reporting: { format: 'table', verbose: false },
};

function skippedResult(): RecipeCheckResult {
  return {
    checkId: 'check-id',
    checkSlug: 'optional-command',
    passed: true,
    violationCount: 0,
    errorCount: 0,
    warningCount: 0,
    ignoredCount: 0,
    durationMs: 1,
    skipped: true,
    skipReason: 'tool-not-installed',
    effectiveSignals: [],
  };
}

describe('buildRecipeResult skipped summary', () => {
  it('counts explicit skips as well as checks the scheduler never ran', () => {
    const session = createRecipeSession('session-id', recipe);
    session.totalChecks = 2;
    session.completedChecks = 1;
    session.passedChecks = 1;
    session.checkResults.push(skippedResult());
    session.status = 'completed';

    const result = buildRecipeResult(session);

    expect(result.summary.skippedChecks).toBe(2);
  });
});
