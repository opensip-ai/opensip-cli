/**
 * @fileoverview `graph-recipes` list command (Plan B, Phase 5 Task 5.4).
 * Asserts `listGraphRecipes()` returns the shared `ListRecipesResult` shape
 * with the default recipe listed as "all rules".
 */

import { runWithScope } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { makeGraphTestScope } from '../../__tests__/test-utils/with-graph-scope.js';
import { listGraphRecipes } from '../list-graph-recipes.js';

describe('listGraphRecipes', () => {
  it('returns a ListRecipesResult listing the default recipe as "all rules"', async () => {
    const result = await runWithScope(makeGraphTestScope(), () => listGraphRecipes());
    expect(result.type).toBe('list-recipes');
    const def = result.recipes.find((r) => r.name === 'default');
    expect(def).toBeDefined();
    expect(def?.checkCount).toBe('all rules');
  });

  it('reports a subset recipe with an N-rules count', async () => {
    const result = await runWithScope(makeGraphTestScope(), () => listGraphRecipes());
    const deadCode = result.recipes.find((r) => r.name === 'dead-code');
    expect(deadCode?.checkCount).toBe('2 rules');
  });
});
