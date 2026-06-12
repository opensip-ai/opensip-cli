/**
 * SaaS-mode tool-subscope concurrent-scope smoke test (Item 1).
 *
 * Companion to `saas-mode-smoke.test.ts`. That file proves the
 * kernel-level RunScope fields (logger, parseCache, recipeUnitConfig,
 * tools, languages) are per-scope. This file proves the tool-level
 * subscopes added in Item 1 — `scope.simulation.{scenarios,recipes}`
 * and `scope.graph.{adapters,rules}` — are per-scope too.
 *
 * The setup mirrors the kernel-level smoke test: construct two
 * RunScopes side-by-side, attach simulation + graph subscopes via each
 * tool's `contributeScope` hook, register a fixture into one scope's
 * subscope, and verify the other scope's subscope is independent.
 */

import { RunScope, runWithScope } from '@opensip-cli/core';
import { GraphAdapterRegistry, graphTool } from '@opensip-cli/graph';
import { simulationTool } from '@opensip-cli/simulation';
import {
  SimulationRecipeRegistry,
  createScenarioRegistry,
} from '@opensip-cli/simulation/internal';
import { describe, expect, it } from 'vitest';

import type { GraphLanguageAdapter } from '@opensip-cli/graph';
import type { RunnableScenario } from '@opensip-cli/simulation';

/** Fresh scope with both tool subscopes attached. */
function makeScopeWithBothTools(): RunScope {
  const scope = new RunScope();
  Object.assign(scope, simulationTool.contributeScope?.() ?? {});
  Object.assign(scope, graphTool.contributeScope?.() ?? {});
  return scope;
}

/** Stub adapter — minimal shape that satisfies GraphLanguageAdapter. */
function stubAdapter(id: string): GraphLanguageAdapter {
  return {
    id,
    fileExtensions: [`.${id}`],
    displayName: id,
    discoverFiles: () => ({ projectDirAbs: '/test', files: [] }),
    parseProject: () => ({ project: null, parseErrors: [] }),
    walkProject: () => ({ occurrences: {}, callSites: [], parseErrors: [] }),
    resolveCallSites: () => ({
      edgesByOwner: new Map(),
      stats: {
        totalCallSites: 0,
        resolvedHigh: 0,
        resolvedMedium: 0,
        resolvedLow: 0,
        unresolved: 0,
      },
    }),
    cacheKey: () => `${id}-v1`,
  };
}

/** Stub scenario — minimal shape that satisfies RunnableScenario. */
function stubScenario(id: string): RunnableScenario {
  return {
    id,
    name: id,
    description: id,
    kind: 'load',
    tags: [],
    run: () =>
      Promise.resolve({
        kind: 'load' as const,
        scenarioId: id,
        passed: true,
        durationMs: 0,
        signals: [],
      } as unknown as Awaited<ReturnType<RunnableScenario['run']>>),
  };
}

describe('SaaS-mode tool-subscope isolation', () => {
  it('scope.simulation.scenarios is independent per RunScope', async () => {
    const scopeA = makeScopeWithBothTools();
    const scopeB = makeScopeWithBothTools();

    await Promise.all([
      runWithScope(scopeA, () => {
        scopeA.simulation!.scenarios.register(stubScenario('only-in-a'));
        return Promise.resolve();
      }),
      runWithScope(scopeB, () => {
        scopeB.simulation!.scenarios.register(stubScenario('only-in-b'));
        return Promise.resolve();
      }),
    ]);

    expect(scopeA.simulation!.scenarios.get('only-in-a')).toBeDefined();
    expect(scopeA.simulation!.scenarios.get('only-in-b')).toBeUndefined();
    expect(scopeB.simulation!.scenarios.get('only-in-b')).toBeDefined();
    expect(scopeB.simulation!.scenarios.get('only-in-a')).toBeUndefined();

    // The registry instances themselves are distinct.
    expect(scopeA.simulation!.scenarios).not.toBe(scopeB.simulation!.scenarios);

    scopeA.dispose();
    scopeB.dispose();
  });

  it('scope.simulation.recipes is independent per RunScope', () => {
    const scopeA = makeScopeWithBothTools();
    const scopeB = makeScopeWithBothTools();

    // Both registries are seeded with the same built-in `default`
    // recipe at construction, but the instances are distinct.
    expect(scopeA.simulation!.recipes).toBeInstanceOf(SimulationRecipeRegistry);
    expect(scopeA.simulation!.recipes).not.toBe(scopeB.simulation!.recipes);
    expect(scopeA.simulation!.recipes.getByName('default')).toBeDefined();
    expect(scopeB.simulation!.recipes.getByName('default')).toBeDefined();

    scopeA.simulation!.recipes.register({
      id: 'URCP_a',
      name: 'a-only',
      displayName: 'A',
      description: 'd',
      scenarios: { type: 'all' },
      execution: { mode: 'parallel' },
    });

    expect(scopeA.simulation!.recipes.has('a-only')).toBe(true);
    expect(scopeB.simulation!.recipes.has('a-only')).toBe(false);

    scopeA.dispose();
    scopeB.dispose();
  });

  it('scope.graph.adapters is independent per RunScope', async () => {
    const scopeA = makeScopeWithBothTools();
    const scopeB = makeScopeWithBothTools();

    await Promise.all([
      runWithScope(scopeA, () => {
        scopeA.graph!.adapters.register(stubAdapter('alpha'));
        return Promise.resolve();
      }),
      runWithScope(scopeB, () => {
        scopeB.graph!.adapters.register(stubAdapter('bravo'));
        return Promise.resolve();
      }),
    ]);

    expect(scopeA.graph!.adapters).toBeInstanceOf(GraphAdapterRegistry);
    expect(scopeA.graph!.adapters).not.toBe(scopeB.graph!.adapters);
    expect(scopeA.graph!.adapters.getById('alpha')).toBeDefined();
    expect(scopeA.graph!.adapters.getById('bravo')).toBeUndefined();
    expect(scopeB.graph!.adapters.getById('bravo')).toBeDefined();
    expect(scopeB.graph!.adapters.getById('alpha')).toBeUndefined();

    scopeA.dispose();
    scopeB.dispose();
  });

  it('scope.graph.rules is independent per RunScope', () => {
    const scopeA = makeScopeWithBothTools();
    const scopeB = makeScopeWithBothTools();

    expect(scopeA.graph!.rules).not.toBe(scopeB.graph!.rules);
    // Both are seeded with the same built-in rules at construction.
    expect(scopeA.graph!.rules.getAll().length).toBeGreaterThan(0);
    expect(scopeA.graph!.rules.getAll().length).toBe(scopeB.graph!.rules.getAll().length);

    scopeA.dispose();
    scopeB.dispose();
  });

  it('scopes that DO NOT load a tool have no subscope for it', () => {
    // Bare scope — no simulationTool.contributeScope, no graphTool.contributeScope.
    const bareScope = new RunScope();

    expect(bareScope.simulation).toBeUndefined();
    expect(bareScope.graph).toBeUndefined();

    bareScope.dispose();
  });

  it('a scope can load just one tool (graph-only run carries no simulation)', () => {
    const graphOnly = new RunScope();
    Object.assign(graphOnly, graphTool.contributeScope?.() ?? {});

    expect(graphOnly.graph).toBeDefined();
    expect(graphOnly.simulation).toBeUndefined();

    graphOnly.dispose();
  });

  it('createScenarioRegistry produces independent instances', () => {
    // Sanity: the factories don't share static state.
    const r1 = createScenarioRegistry();
    const r2 = createScenarioRegistry();
    r1.register(stubScenario('in-r1'));
    expect(r1.size).toBe(1);
    expect(r2.size).toBe(0);
  });
});
