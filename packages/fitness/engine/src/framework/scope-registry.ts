/**
 * @fileoverview Scope-owned fitness registries — the simulation pattern.
 *
 * Each `RunScope` owns its own check + recipe registries (D7 — tool
 * subscopes via module augmentation). The fitness tool's
 * `contributeScope` hook constructs fresh registries per CLI invocation
 * and attaches them to `scope.fitness.{checks,recipes}`. The module-level
 * singletons (`defaultRegistry` / `defaultRecipeRegistry`) are gone —
 * consumers read via `currentCheckRegistry()` / `currentRecipeRegistry()`,
 * which route through the scope-bound instances and throw outside a scope.
 *
 * Public API (mirrors simulation's `createScenarioRegistry` /
 * `currentScenarioRegistry`):
 *   - `createCheckRegistry()`   — factory used by `contributeScope`.
 *   - `createRecipeRegistry()`  — factory used by `contributeScope`.
 *   - `createFitnessLoadState()`— fresh `ensureChecksLoaded` lifecycle slot.
 *   - `currentCheckRegistry()`  — reads `scope.fitness.checks`; throws
 *                                 outside a scope / when the subscope is absent.
 *   - `currentRecipeRegistry()` — reads `scope.fitness.recipes`; same throws.
 *   - `currentFitnessLoadState()` — reads `scope.fitness.load`; same throws.
 */

import { currentScope } from '@opensip-cli/core';

import { FitnessRecipeRegistry } from '../recipes/registry.js';

import { type MemoryProfiler, memoryProfiler } from './memory-profiler.js';
import { CheckRegistry } from './registry.js';

import type { FitnessLoadState, FitnessSubscope } from '../scope-augmentation.js';

// Side-effect import: ensures the `ScopeContribution.fitness` augmentation is
// loaded so `scope.fitness` is the correctly-typed slot at every read site.
import '../scope-augmentation.js';

/** Construct a fresh check registry for a single `RunScope`. */
export function createCheckRegistry(): CheckRegistry {
  return new CheckRegistry();
}

/** Construct a fresh recipe registry (built-ins pre-seeded) for a single `RunScope`. */
export function createRecipeRegistry(): FitnessRecipeRegistry {
  return new FitnessRecipeRegistry();
}

/** Construct a fresh, empty `ensureChecksLoaded` lifecycle slot for a `RunScope`. */
export function createFitnessLoadState(): FitnessLoadState {
  return {
    loadedFor: null,
    pluginLoadErrors: [],
    checkPackErrors: [],
    loadWarnings: [],
    degradedDiagnostics: [],
  };
}

/**
 * Read the current scope's fitness subscope. Throws when no scope is
 * active or when the fitness subscope is missing — both indicate the
 * caller is running outside the CLI's pre-action-hook (or the test
 * fixture forgot to construct + enter a scope).
 *
 * @throws {Error} When called outside `runWithScope(...)`, or when the
 *   active scope has no fitness subscope.
 */
function currentFitnessSubscope(): FitnessSubscope {
  const scope = currentScope();
  if (!scope) {
    throw new Error(
      'fitness: scope read attempted outside a RunScope. ' +
        'Wrap the call site in runWithScope (production: pre-action-hook handles ' +
        'this; tests: use makeTestScope + fitnessTool.contributeScope or construct ' +
        'the registries directly).',
    );
  }
  if (!scope.fitness) {
    throw new Error(
      'fitness: scope.fitness is missing. The fitness tool must be ' +
        'registered and its contributeScope hook must run before check/recipe reads. ' +
        '(production: bootstrap registers fitnessTool; tests: call ' +
        'fitnessTool.contributeScope() after makeTestScope.)',
    );
  }
  return scope.fitness;
}

/** Read the current scope's check registry. */
export function currentCheckRegistry(): CheckRegistry {
  return currentFitnessSubscope().checks;
}

/** Read the current scope's recipe registry. */
export function currentRecipeRegistry(): FitnessRecipeRegistry {
  return currentFitnessSubscope().recipes;
}

/** Read the current scope's `ensureChecksLoaded` lifecycle state. */
export function currentFitnessLoadState(): FitnessLoadState {
  return currentFitnessSubscope().load;
}

/** Read the current scope's per-run memory profiler. */
export function currentMemoryProfiler(): MemoryProfiler {
  return currentFitnessSubscope().memoryProfiler;
}

/**
 * Resolve the active memory profiler: scope-bound in production, falling back
 * to the test-only module singleton when no fitness subscope is present.
 */
export function resolveMemoryProfiler(): MemoryProfiler {
  return currentScope()?.fitness?.memoryProfiler ?? memoryProfiler;
}
