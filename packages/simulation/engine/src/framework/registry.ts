/**
 * @fileoverview Cross-kind scenario registry — per-RunScope.
 *
 * Each `RunScope` owns its own `Registry<RunnableScenario>` (Item 1 /
 * D7 — see docs/plans/ready/architecture-runscope-and-registry/item-1-tool-subscopes.md).
 * The simulation tool's `extendScope` hook constructs a fresh registry
 * per CLI invocation and attaches it to `scope.simulation.scenarios`.
 *
 * Built on the kernel's unified `Registry<T>` with
 * `duplicatePolicy: 'silent-skip'` (re-importing the same scenario is a
 * no-op) + `nameCollisionMode: 'throw'` (two different scenario ids
 * sharing a name would corrupt the dual-key state). This is the same
 * shape the legacy `IdNameTagRegistry` provided (which has been deleted).
 *
 * Public API:
 *   - `createScenarioRegistry()`  — factory used by `extendScope`.
 *   - `currentScenarioRegistry()` — reads the scope-bound registry;
 *                                   throws when called outside a scope
 *                                   or when `simulation` subscope is
 *                                   absent.
 *   - `getRegisteredScenarios()` / `getScenario` / `getScenariosByTag` /
 *     `getScenariosByKind` / `clearScenarioRegistry` — thin helpers that
 *     route through the scope-bound registry.
 */

import { Registry, currentScope } from '@opensip-tools/core'

import type { RunnableScenario } from './runnable-scenario.js'
import type { ScenarioKind } from '../types/kind-types.js'

/** Construct a fresh scenario registry for a single `RunScope`. */
export function createScenarioRegistry(): Registry<RunnableScenario> {
  return new Registry<RunnableScenario>({
    module: 'simulation:scenarios',
    duplicatePolicy: 'silent-skip',
    evtPrefix: 'scenario.registry',
    nameCollisionMode: 'throw',
    validationCode: 'VALIDATION.REGISTRY.NAME_COLLISION',
  })
}

/**
 * Read the current scope's scenario registry. Throws when no scope is
 * active or when the simulation subscope is missing — both indicate the
 * caller is running outside the CLI's pre-action-hook (or the test
 * fixture forgot to construct + enter a scope).
 *
 * @throws {Error} When called outside `runWithScope(...)`, or when the
 *   active scope has no simulation subscope.
 */
export function currentScenarioRegistry(): Registry<RunnableScenario> {
  const scope = currentScope()
  if (!scope) {
    throw new Error(
      'simulation: currentScenarioRegistry() called outside a RunScope. ' +
        'Wrap the call site in runWithScope (production: pre-action-hook handles ' +
        'this; tests: use makeTestScope + simulationTool.extendScope or construct ' +
        'a Registry directly).',
    )
  }
  if (!scope.simulation) {
    throw new Error(
      'simulation: scope.simulation is missing. The simulation tool must be ' +
        'registered and its extendScope hook must run before scenario reads. ' +
        '(production: bootstrap registers simulationTool; tests: call ' +
        'simulationTool.extendScope(scope) after makeTestScope.)',
    )
  }
  return scope.simulation.scenarios
}

/** Get all registered scenarios from the current scope's registry. */
export function getRegisteredScenarios(): Map<string, RunnableScenario> {
  const map = new Map<string, RunnableScenario>()
  for (const scenario of currentScenarioRegistry().getAll()) {
    map.set(scenario.id, scenario)
  }
  return map
}

/** Get a scenario by id or name from the current scope's registry. */
export function getScenario(idOrName: string): RunnableScenario | undefined {
  return currentScenarioRegistry().get(idOrName)
}

/** Get scenarios filtered by tag (any kind). */
export function getScenariosByTag(tag: string): readonly RunnableScenario[] {
  return currentScenarioRegistry().getByTag(tag)
}

/** Get scenarios filtered by kind. */
export function getScenariosByKind(kind: ScenarioKind): RunnableScenario[] {
  return currentScenarioRegistry().getAll().filter((s) => s.kind === kind)
}

/**
 * Clear the current scope's scenario registry. Used by tests, by host
 * applications that need to swap the scenario set at runtime, and by
 * recipe-reset code paths. The simulation engine's plugin loader
 * re-populates it on the next load cycle.
 */
export function clearScenarioRegistry(): void {
  currentScenarioRegistry().clear()
}
