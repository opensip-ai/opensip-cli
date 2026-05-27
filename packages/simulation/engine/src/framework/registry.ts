/**
 * @fileoverview Cross-kind scenario registry.
 *
 * Replaces the legacy load-only registry from `define-scenario.ts`. All four
 * `defineXxxScenario` entry points register here. Tag-based filtering and
 * `--kind` filtering (the CLI surface) work uniformly across kinds.
 *
 * Built on the kernel's unified `Registry<T>` with
 * `duplicatePolicy: 'silent-skip'` (re-importing the same scenario is a
 * no-op) + `nameCollisionMode: 'throw'` (two different scenario ids
 * sharing a name would corrupt the dual-key state). This is the same
 * shape the legacy `IdNameTagRegistry` provided (which has been deleted).
 */

import { Registry } from '@opensip-tools/core'

import type { RunnableScenario } from './runnable-scenario.js'
import type { ScenarioKind } from '../types/kind-types.js'

/** Singleton registry for scenarios across every kind. */
export const scenarioRegistry = new Registry<RunnableScenario>({
  module: 'simulation:scenarios',
  duplicatePolicy: 'silent-skip',
  evtPrefix: 'scenario.registry',
  nameCollisionMode: 'throw',
  validationCode: 'VALIDATION.REGISTRY.NAME_COLLISION',
})

/** Get all registered scenarios. */
export function getRegisteredScenarios(): Map<string, RunnableScenario> {
  const map = new Map<string, RunnableScenario>()
  for (const scenario of scenarioRegistry.getAll()) {
    map.set(scenario.id, scenario)
  }
  return map
}

/** Get a scenario by id or name. */
export function getScenario(idOrName: string): RunnableScenario | undefined {
  return scenarioRegistry.get(idOrName)
}

/** Get scenarios filtered by tag (any kind). */
export function getScenariosByTag(tag: string): readonly RunnableScenario[] {
  return scenarioRegistry.getByTag(tag)
}

/** Get scenarios filtered by kind. */
export function getScenariosByKind(kind: ScenarioKind): RunnableScenario[] {
  return scenarioRegistry.getAll().filter((s) => s.kind === kind)
}

/** Clear the registry. Primarily for tests. */
export function clearScenarioRegistry(): void {
  scenarioRegistry.clear()
}
