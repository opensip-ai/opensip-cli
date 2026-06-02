/**
 * @fileoverview Recipe name → rule-subset resolution (Plan B, Phase 5 Task 5.3).
 *
 * Locks the default-unchanged invariant: no `--recipe` (undefined) and
 * `--recipe default` resolve to the exact same rule set/order as
 * `currentRules()` (all built-ins, registration order). A subset recipe
 * resolves to exactly its rules; an unknown name raises a ConfigurationError.
 */

import { ConfigurationError, runWithScopeSync } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { makeGraphTestScope } from '../../__tests__/test-utils/with-graph-scope.js';
import { currentRules } from '../../rules/registry.js';
import { resolveRecipeToRules } from '../resolve.js';

describe('resolveRecipeToRules', () => {
  it('no recipe (undefined) == --recipe default == all rules, in registration order', () => {
    runWithScopeSync(makeGraphTestScope(), () => {
      const allSlugs = currentRules().map((r) => r.slug);
      const undefSlugs = resolveRecipeToRules(undefined).map((r) => r.slug);
      const defaultSlugs = resolveRecipeToRules('default').map((r) => r.slug);
      expect(undefSlugs).toEqual(allSlugs);
      expect(defaultSlugs).toEqual(allSlugs);
    });
  });

  it('a subset recipe resolves to exactly its rule slugs', () => {
    runWithScopeSync(makeGraphTestScope(), () => {
      const slugs = resolveRecipeToRules('dead-code').map((r) => r.slug);
      expect(slugs).toEqual(['graph:orphan-subtree', 'graph:test-only-reachable']);
    });
  });

  it('an unknown recipe name throws ConfigurationError', () => {
    runWithScopeSync(makeGraphTestScope(), () => {
      expect(() => resolveRecipeToRules('bogus')).toThrow(ConfigurationError);
      expect(() => resolveRecipeToRules('bogus')).toThrow(/Unknown graph recipe 'bogus'/);
    });
  });
});
