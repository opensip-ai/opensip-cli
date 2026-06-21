import { describe, expect, it } from 'vitest';

import { collectSimulationReportData } from '../report-data.js';

import type { ToolScope } from '@opensip-cli/core';

/**
 * Unit tests for sim's report-data contribution (L6). A minimal fake scope
 * exercises both the populated and absent-subscope branches without standing up
 * the full registries.
 */

const scenario = {
  kind: 'load',
  id: 's1',
  name: 'Load Test',
  description: 'a load scenario',
  tags: ['perf'],
};
const recipe = {
  id: 'r1',
  name: 'default',
  displayName: 'Default',
  description: 'the default recipe',
  tags: ['ci'],
};

function scopeWith(sim: unknown): ToolScope {
  return { simulation: sim } as unknown as ToolScope;
}

describe('collectSimulationReportData', () => {
  it('maps registered scenarios + recipes into sim-namespaced dashboard catalogs', () => {
    const out = collectSimulationReportData(
      scopeWith({
        scenarios: { getAll: () => [scenario] },
        recipes: { getAllRecipes: () => [recipe] },
      }),
    ) as {
      simScenarioCatalog: readonly Record<string, unknown>[];
      simRecipeCatalog: readonly Record<string, unknown>[];
    };

    expect(out.simScenarioCatalog).toEqual([
      { id: 's1', name: 'Load Test', kind: 'load', description: 'a load scenario', tags: ['perf'] },
    ]);
    expect(out.simRecipeCatalog).toEqual([
      { name: 'default', displayName: 'Default', description: 'the default recipe', tags: ['ci'] },
    ]);
  });

  it('returns empty catalogs when the sim subscope is absent', () => {
    const out = collectSimulationReportData(scopeWith(undefined)) as {
      simScenarioCatalog: readonly unknown[];
      simRecipeCatalog: readonly unknown[];
    };
    expect(out.simScenarioCatalog).toEqual([]);
    expect(out.simRecipeCatalog).toEqual([]);
  });
});
