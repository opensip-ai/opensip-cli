/**
 * @fileoverview RunScope augmentation for simulation.
 *
 * D7 (tool subscopes via module augmentation, per the RunScope/
 * Registry architecture): tool-specific concerns nest under the
 * tool's name on `RunScope` and
 * are added via TypeScript module augmentation from the tool's own
 * package. Core never imports simulation-shaped types — the layer rule
 * stays intact (`core ← contracts ← {simulation, ...}`).
 *
 * Two singletons used to hang off this package as module-level state:
 *
 *   - `scenarioRegistry`                — per-process scenario registry.
 *   - `defaultSimulationRecipeRegistry` — per-process recipe registry.
 *
 * Both are now per-RunScope. The simulation tool's `contributeScope` hook
 * (in `tool.ts`) instantiates fresh registries and attaches them to
 * `scope.simulation` once per CLI invocation. Tools and library code
 * read via `currentScope()?.simulation?.{scenarios,recipes}`.
 *
 * The `simulation` slot is intentionally optional and mutable (no
 * `readonly`) on the augmented interface: the kernel doesn't construct
 * it, and only the simulation tool's `contributeScope` writes to it during
 * scope construction. A run that doesn't load the simulation tool
 * carries no `scope.simulation`, and reads return `undefined`.
 */

import type { RunnableScenario } from './framework/runnable-scenario.js';
import type { SimulationRecipeRegistry } from './recipes/registry.js';
import type { Registry } from '@opensip-cli/core';

/**
 * Per-RunScope `ensureScenariosLoaded` lifecycle state — moved off the `sim.ts`
 * module singletons (`scenariosLoadedFor` / `pluginLoadErrors`) so two concurrent
 * sim runs carry independent load state (audit F1). Mutable: written once per run
 * by `ensureScenariosLoaded`; read by `getPluginLoadErrors`.
 */
export interface SimulationLoadState {
  /** Project directory `ensureScenariosLoaded` has completed for in THIS scope.
   *  `null` before the first load; `''` is the "loaded" sentinel for no-project. */
  loadedFor: string | null;
  /** Plugin load failures from the most recent `ensureScenariosLoaded` call. */
  pluginLoadErrors: readonly string[];
}

/**
 * Per-RunScope simulation state. Constructed by the simulation tool's
 * `contributeScope()` hook and attached to `scope.simulation`.
 */
export interface SimulationSubscope {
  /** Scenario registry — populated through the generic capability loader
   *  (`sim-pack` domain) + `loadAllSimPlugins` during `ensureScenariosLoaded`. */
  readonly scenarios: Registry<RunnableScenario>;
  /** Recipe registry — seeded with built-in recipes at construction;
   *  plugin loader + the sim-recipe domain register user recipes. */
  readonly recipes: SimulationRecipeRegistry;
  /** `ensureScenariosLoaded` lifecycle state for this run (audit F1). */
  readonly load: SimulationLoadState;
}

declare module '@opensip-cli/core' {
  interface ScopeContribution {
    /**
     * Simulation tool's per-run state. Returned by the simulation tool's
     * `contributeScope` hook and installed by the kernel; absent in runs
     * where the simulation tool is not registered. Consumers MUST
     * null-check before reading. Augments `ScopeContribution`, which
     * `ToolScope`/`RunScope` extend — so `cli.scope.simulation` /
     * `currentScope()?.simulation` stay readable (audit 2026-05-29, M4).
     */
    simulation?: SimulationSubscope;
  }
}
