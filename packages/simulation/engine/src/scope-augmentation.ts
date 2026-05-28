/**
 * @fileoverview RunScope augmentation for simulation.
 *
 * D7 (see docs/plans/ready/architecture-runscope-and-registry/phase-0-audit-and-design.md):
 * tool-specific concerns nest under the tool's name on `RunScope` and
 * are added via TypeScript module augmentation from the tool's own
 * package. Core never imports simulation-shaped types — the layer rule
 * stays intact (`core ← contracts ← {simulation, ...}`).
 *
 * Two singletons used to hang off this package as module-level state:
 *
 *   - `scenarioRegistry`                — per-process scenario registry.
 *   - `defaultSimulationRecipeRegistry` — per-process recipe registry.
 *
 * Both are now per-RunScope. The simulation tool's `extendScope` hook
 * (in `tool.ts`) instantiates fresh registries and attaches them to
 * `scope.simulation` once per CLI invocation. Tools and library code
 * read via `currentScope()?.simulation?.{scenarios,recipes}`.
 *
 * The `simulation` slot is intentionally optional and mutable (no
 * `readonly`) on the augmented interface: the kernel doesn't construct
 * it, and only the simulation tool's `extendScope` writes to it during
 * scope construction. A run that doesn't load the simulation tool
 * carries no `scope.simulation`, and reads return `undefined`.
 */

import type { RunnableScenario } from './framework/runnable-scenario.js';
import type { SimulationRecipeRegistry } from './recipes/registry.js';
import type { Registry } from '@opensip-tools/core';

/**
 * Per-RunScope simulation state. Constructed by the simulation tool's
 * `extendScope(scope)` hook and attached to `scope.simulation`.
 */
export interface SimulationSubscope {
  /** Scenario registry — populated by `loadAllSimPlugins` /
   *  `loadDiscoveredScenarioPackages` during `ensureScenariosLoaded`. */
  readonly scenarios: Registry<RunnableScenario>;
  /** Recipe registry — seeded with built-in recipes at construction;
   *  plugin loader registers user recipes. */
  readonly recipes: SimulationRecipeRegistry;
}

declare module '@opensip-tools/core' {
  interface RunScope {
    /**
     * Simulation tool's per-run state. Populated by the simulation
     * tool's `extendScope` hook; absent in runs where the simulation
     * tool is not registered. Consumers MUST null-check before reading.
     */
    simulation?: SimulationSubscope;
  }
}
