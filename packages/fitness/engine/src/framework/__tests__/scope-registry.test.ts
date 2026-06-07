/**
 * @fileoverview Scope-owned fitness registry contract (mirrors simulation's
 * scope-bound registry tests). Covers the factories, the scope readers, the
 * throw-outside-scope guards, and scope isolation — two concurrent
 * `runWithScope` contexts must carry INDEPENDENT check/recipe registries.
 */

import { RunScope, runWithScope } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { defineRecipe } from '../../recipes/types.js';
import { fitnessTool } from '../../tool.js';
import { defineCheck } from '../define-check.js';
import {
  createCheckRegistry,
  createFitnessLoadState,
  createRecipeRegistry,
  currentCheckRegistry,
  currentFitnessLoadState,
  currentRecipeRegistry,
} from '../scope-registry.js';


import type { Check } from '../check-types.js';

let nextId = 0;
function stubCheck(slug: string): Check {
  nextId++;
  return defineCheck({
    id: `00000000-0000-4000-8000-${nextId.toString(16).padStart(12, '0')}`,
    slug,
    description: slug,
    tags: ['demo'],
    analyze: () => [],
  });
}

/** Minimal user recipe for isolation assertions. */
function stubRecipe(name: string) {
  return defineRecipe({
    name,
    displayName: name,
    description: name,
    checks: { type: 'all' },
  });
}

/** Construct a RunScope carrying fitness's contributed subscope. */
function fitnessScope(): RunScope {
  const scope = new RunScope();
  Object.assign(scope, fitnessTool.contributeScope?.() ?? {});
  return scope;
}

describe('fitness scope-registry — factories', () => {
  it('createCheckRegistry returns a fresh empty CheckRegistry', () => {
    const reg = createCheckRegistry();
    expect(reg.size).toBe(0);
    reg.register(stubCheck('factory-check'));
    expect(reg.size).toBe(1);
  });

  it('createRecipeRegistry returns a registry pre-seeded with built-ins', () => {
    const reg = createRecipeRegistry();
    expect(reg.has('default')).toBe(true);
  });

  it('createFitnessLoadState returns an empty lifecycle slot', () => {
    const load = createFitnessLoadState();
    expect(load.loadedFor).toBeNull();
    expect(load.pluginLoadErrors).toEqual([]);
    expect(load.loadWarnings).toEqual([]);
  });
});

describe('fitness scope-registry — readers throw outside a scope', () => {
  it('currentCheckRegistry throws when no scope is active', () => {
    expect(() => currentCheckRegistry()).toThrow(/outside a RunScope/);
  });

  it('currentRecipeRegistry throws when no scope is active', () => {
    expect(() => currentRecipeRegistry()).toThrow(/outside a RunScope/);
  });

  it('currentFitnessLoadState throws when no scope is active', () => {
    expect(() => currentFitnessLoadState()).toThrow(/outside a RunScope/);
  });

  it('readers throw when the scope has no fitness subscope', async () => {
    await runWithScope(new RunScope(), () => {
      expect(() => currentCheckRegistry()).toThrow(/scope\.fitness is missing/);
      expect(() => currentRecipeRegistry()).toThrow(/scope\.fitness is missing/);
      expect(() => currentFitnessLoadState()).toThrow(/scope\.fitness is missing/);
      return Promise.resolve();
    });
  });
});

describe('fitness scope-registry — readers resolve the scope-bound instances', () => {
  it('currentCheckRegistry returns the scope.fitness.checks instance', async () => {
    const scope = fitnessScope();
    await runWithScope(scope, () => {
      expect(currentCheckRegistry()).toBe(scope.fitness?.checks);
      return Promise.resolve();
    });
  });

  it('currentRecipeRegistry returns the scope.fitness.recipes instance', async () => {
    const scope = fitnessScope();
    await runWithScope(scope, () => {
      expect(currentRecipeRegistry()).toBe(scope.fitness?.recipes);
      return Promise.resolve();
    });
  });
});

describe('fitness scope-registry — scope isolation', () => {
  it('two scopes carry INDEPENDENT check registries', async () => {
    const scopeA = fitnessScope();
    const scopeB = fitnessScope();

    await runWithScope(scopeA, () => {
      currentCheckRegistry().register(stubCheck('only-in-a'), 'a');
      return Promise.resolve();
    });
    await runWithScope(scopeB, () => {
      currentCheckRegistry().register(stubCheck('only-in-b'), 'b');
      return Promise.resolve();
    });

    await runWithScope(scopeA, () => {
      expect(currentCheckRegistry().getBySlug('a:only-in-a')).toBeDefined();
      expect(currentCheckRegistry().getBySlug('b:only-in-b')).toBeUndefined();
      return Promise.resolve();
    });
    await runWithScope(scopeB, () => {
      expect(currentCheckRegistry().getBySlug('b:only-in-b')).toBeDefined();
      expect(currentCheckRegistry().getBySlug('a:only-in-a')).toBeUndefined();
      return Promise.resolve();
    });
  });

  it('two scopes carry INDEPENDENT recipe registries', async () => {
    const scopeA = fitnessScope();
    const scopeB = fitnessScope();

    await runWithScope(scopeA, () => {
      currentRecipeRegistry().register(stubRecipe('only-in-a'));
      return Promise.resolve();
    });
    await runWithScope(scopeB, () => {
      currentRecipeRegistry().register(stubRecipe('only-in-b'));
      return Promise.resolve();
    });

    await runWithScope(scopeA, () => {
      // A's user recipe is visible in A; B's is not. Built-ins stay shared-by-value.
      expect(currentRecipeRegistry().has('only-in-a')).toBe(true);
      expect(currentRecipeRegistry().has('only-in-b')).toBe(false);
      expect(currentRecipeRegistry().has('default')).toBe(true);
      return Promise.resolve();
    });
    await runWithScope(scopeB, () => {
      expect(currentRecipeRegistry().has('only-in-b')).toBe(true);
      expect(currentRecipeRegistry().has('only-in-a')).toBe(false);
      return Promise.resolve();
    });
  });

  it('two scopes carry INDEPENDENT load state', async () => {
    const scopeA = fitnessScope();
    const scopeB = fitnessScope();

    await runWithScope(scopeA, () => {
      currentFitnessLoadState().loadedFor = '/project/a';
      return Promise.resolve();
    });

    await runWithScope(scopeA, () => {
      expect(currentFitnessLoadState().loadedFor).toBe('/project/a');
      return Promise.resolve();
    });
    await runWithScope(scopeB, () => {
      expect(currentFitnessLoadState().loadedFor).toBeNull();
      return Promise.resolve();
    });
  });
});
