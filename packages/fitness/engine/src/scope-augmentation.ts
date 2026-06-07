/**
 * @fileoverview RunScope augmentation for fitness.
 *
 * D7 (tool subscopes via module augmentation, per the RunScope/
 * Registry architecture): tool-specific concerns nest under the tool's
 * name on `RunScope` and are added via TypeScript module augmentation
 * from the tool's own package. Core never imports fitness-shaped types —
 * the layer rule stays intact (`core ← contracts ← {fitness, ...}`).
 *
 * Two singletons used to hang off this package as module-level state:
 *
 *   - `defaultRegistry`       — per-process check registry.
 *   - `defaultRecipeRegistry` — per-process recipe registry.
 *
 * plus the per-process `ensureChecksLoaded` lifecycle state (the
 * `checksLoadedFor` / `pluginLoadErrors` / `loadWarnings` triple).
 *
 * All of it is now per-RunScope. The fitness tool's `contributeScope`
 * hook (in `tool.ts`) instantiates fresh registries + a fresh `load`
 * marker and attaches them to `scope.fitness` once per CLI invocation.
 * Tools and library code read via
 * `currentScope()?.fitness?.{checks,recipes,load}`.
 *
 * The `fitness` slot is intentionally optional and mutable (no
 * `readonly`) on the augmented interface: the kernel doesn't construct
 * it, and only the fitness tool's `contributeScope` writes to it during
 * scope construction. A run that doesn't load the fitness tool carries
 * no `scope.fitness`, and reads return `undefined`.
 */

import type { CheckRegistry } from './framework/registry.js';
import type { FitnessRecipeRegistry } from './recipes/registry.js';

/**
 * Per-RunScope `ensureChecksLoaded` lifecycle state — moved off the
 * `check-loader.ts` module singletons so two concurrent scopes carry
 * independent load state. Mutable: `ensureChecksLoaded` writes it once
 * per run; the phase helpers (`buildFitEnvelope`, `buildFitDoneResult`)
 * and the public accessors read it back.
 */
export interface FitnessLoadState {
  /** Project directory for which `ensureChecksLoaded` has run to
   *  completion in THIS scope. `null` before the first load; `''` is the
   *  "loaded" sentinel for the no-project case. */
  loadedFor: string | null;
  /** Plugin load failures from the most recent `ensureChecksLoaded` call. */
  pluginLoadErrors: readonly string[];
  /** Non-fatal user-facing warnings collected during the most recent
   *  `ensureChecksLoaded` call. */
  loadWarnings: string[];
}

/**
 * Per-RunScope fitness state. Constructed by the fitness tool's
 * `contributeScope()` hook and attached to `scope.fitness`.
 */
export interface FitnessSubscope {
  /** Check registry — populated by `loadAllPlugins` /
   *  `loadDiscoveredCheckPackages` during `ensureChecksLoaded`. */
  readonly checks: CheckRegistry;
  /** Recipe registry — seeded with built-in recipes at construction;
   *  plugin loader registers user recipes. */
  readonly recipes: FitnessRecipeRegistry;
  /** `ensureChecksLoaded` lifecycle state for this run. */
  readonly load: FitnessLoadState;
}

declare module '@opensip-tools/core' {
  interface ScopeContribution {
    /**
     * Fitness tool's per-run state. Returned by the fitness tool's
     * `contributeScope` hook and installed by the kernel; absent in runs
     * where the fitness tool is not registered. Consumers MUST null-check
     * before reading. Augments `ScopeContribution`, which
     * `ToolScope`/`RunScope` extend — so `cli.scope.fitness` /
     * `currentScope()?.fitness` stay readable.
     */
    fitness?: FitnessSubscope;
  }
}
