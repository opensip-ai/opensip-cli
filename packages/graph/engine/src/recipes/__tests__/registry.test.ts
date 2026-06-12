/**
 * @fileoverview Graph recipe registry — built-in seeding + scope-resolution
 * guards on `currentGraphRecipes()` (Plan B, Phase 5 Task 5.3). Mirrors
 * `rules/__tests__/registry.test.ts`.
 */

import { LanguageRegistry, RunScope, ToolRegistry, runWithScopeSync } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { makeGraphTestScope } from '../../__tests__/test-utils/with-graph-scope.js';
import { createRecipeRegistry, currentGraphRecipes } from '../registry.js';

/** Fresh scope with empty registries — local equivalent of the retired
 *  `@opensip-tools/core/test-utils` helper (ADR-0040: that sugar moved to
 *  `@opensip-tools/test-support`, which this package's tests cannot use
 *  without coupling its test graph to the fitness engine). */
const makeTestScope = (): RunScope =>
  new RunScope({ languages: new LanguageRegistry(), tools: new ToolRegistry() });

describe('GraphRecipeRegistry', () => {
  it('seeds the built-in recipes on construction (default present)', () => {
    const registry = createRecipeRegistry();
    const names = registry.getAllRecipes().map((r) => r.name);
    expect(names).toContain('default');
  });
});

describe('currentGraphRecipes', () => {
  it('returns the scope-bound recipe registry inside a graph-extended scope', () => {
    const names = runWithScopeSync(makeGraphTestScope(), () => currentGraphRecipes().getNames());
    expect(names).toContain('default');
  });

  it('throws when called outside any RunScope', () => {
    expect(() => currentGraphRecipes()).toThrow(/outside a RunScope/);
  });

  it('throws when the active scope has no graph subscope', () => {
    expect(() => runWithScopeSync(makeTestScope(), () => currentGraphRecipes())).toThrow(
      /scope\.graph is missing/,
    );
  });
});
