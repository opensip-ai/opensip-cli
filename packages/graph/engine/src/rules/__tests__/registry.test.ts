/**
 * Graph rules registry — the per-RunScope rule registry, its built-in
 * seeding, and the scope-resolution guards on `currentRules()`.
 */

import { runWithScopeSync } from '@opensip-tools/core';
import { makeTestScope } from '@opensip-tools/core/test-utils/with-scope.js';
import { describe, expect, it } from 'vitest';

import { makeGraphTestScope } from '../../__tests__/test-utils/with-graph-scope.js';
import { createRulesRegistry, currentRules } from '../registry.js';

describe('GraphRulesRegistry', () => {
  it('seeds the built-in rules on construction', () => {
    const registry = createRulesRegistry();
    const all = registry.getAll();
    expect(all.length).toBeGreaterThan(0);
    // Every entry is a Rule with the evaluate contract.
    for (const rule of all) expect(typeof rule.evaluate).toBe('function');
  });
});

describe('currentRules', () => {
  it('returns the scope-bound rules inside a graph-extended scope', () => {
    const rules = runWithScopeSync(makeGraphTestScope(), () => currentRules());
    expect(rules.length).toBeGreaterThan(0);
  });

  it('throws when called outside any RunScope', () => {
    expect(() => currentRules()).toThrow(/outside a RunScope/);
  });

  it('throws when the active scope has no graph subscope', () => {
    // A bare test scope has no `.graph` slot (no contributeScope ran).
    expect(() => runWithScopeSync(makeTestScope(), () => currentRules())).toThrow(
      /scope\.graph is missing/,
    );
  });
});
