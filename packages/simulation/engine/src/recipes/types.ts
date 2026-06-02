/**
 * @fileoverview Sim recipe types — mirrors the fitness recipe shape so
 * users get the same mental model across both tools.
 *
 * A recipe is a named bundle that selects scenarios and configures their
 * execution. The user runs `opensip-tools sim --recipe <name>` to invoke
 * one. Without a flag, the built-in `default` recipe applies.
 */

import type { ScenarioKind } from '../types/kind-types.js';

// =============================================================================
// SCENARIO SELECTORS
// =============================================================================

/** Selector that specifies scenarios by explicit ID list. */
export interface ExplicitScenarioSelector {
  readonly type: 'explicit';
  readonly scenarioIds: readonly string[];
}

/** Selector that includes all scenarios with optional exclusions. */
export interface AllScenarioSelector {
  readonly type: 'all';
  readonly exclude?: readonly string[];
}

/** Selector that includes scenarios with specified tags. */
export interface TagsScenarioSelector {
  readonly type: 'tags';
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
}

/** Selector that filters by scenario kind (load / chaos / invariant / fix-evaluation). */
export interface KindScenarioSelector {
  readonly type: 'kind';
  readonly kinds: readonly ScenarioKind[];
  readonly exclude?: readonly string[];
}

/**
 * Union of every scenario-selector shape used by recipes.
 *
 * The `explicit` / `all` / `tags` arms mirror `@opensip-tools/core`'s
 * `RecipeSelector` shape (keeping sim's historical `scenarioIds` field on
 * `explicit`); `kind` is a sim-only arm. Resolution delegates to core's
 * `resolveSelector` via per-arm predicates (see `service.ts`) — sim's
 * id/name-keyed exclude semantics differ from core's tag/glob built-ins, so
 * every arm is supplied as a predicate and core never names `ScenarioKind`.
 */
export type ScenarioSelector =
  | ExplicitScenarioSelector
  | AllScenarioSelector
  | TagsScenarioSelector
  | KindScenarioSelector;

// =============================================================================
// EXECUTION OPTIONS
// =============================================================================

/** Execution configuration for a sim recipe. */
export interface SimulationExecutionOptions {
  readonly mode: 'parallel' | 'sequential';
  readonly timeout?: number;
  readonly maxParallel?: number;
  readonly stopOnFirstFailure?: boolean;
}

// =============================================================================
// SIMULATION RECIPE
// =============================================================================

/** Complete sim-recipe definition: scenarios + execution. */
export interface SimulationRecipe {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly scenarios: ScenarioSelector;
  readonly execution: SimulationExecutionOptions;
  readonly tags?: readonly string[];
}

/** Author-facing config — `kind` is implicit, `id`/`name` are required. */
export type SimulationRecipeConfig = SimulationRecipe;
