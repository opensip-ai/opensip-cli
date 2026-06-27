// Recipes — generic recipe registry shared by fitness + simulation.
export { RecipeRegistry } from './recipes/registry.js';
export type {
  RecipeBase,
  RecipeRegisterOptions,
  RecipeRegistryOptions,
} from './recipes/registry.js';

// Recipes — generic selector union + resolver (selection half of the
// substrate; execution stays tool-owned).
export {
  allUnitsLabel,
  builtInOriginLabel,
  explicitUnitsLabel,
  PATTERN_BASED_LABEL,
  recipeDisplayInfo,
} from './recipes/display.js';
export type { RecipeDisplayInfo, RecipeDisplaySource } from './recipes/display.js';
export { resolveSelector } from './recipes/selector.js';
export type {
  RecipeSelector,
  ExplicitSelector,
  AllSelector,
  TagsSelector,
  PatternSelector,
  ResolveSelectorOptions,
} from './recipes/selector.js';
// Recipes — per-unit config-override accessors + map type.
export {
  getUnitConfig,
  setCurrentRecipeUnitConfig,
  clearCurrentRecipeUnitConfig,
} from './recipes/unit-config.js';
export type { RecipeUnitConfigMap } from './recipes/unit-config.js';

// Generic `Registry<T>` — the unified base for every registry in the
// workspace. Replaces the ten registry classes catalogued in the
// runscope+registry plan's Phase 0. See `lib/registry.ts` for the
// full design rationale + the closed `DuplicatePolicy` union.
//
// `Registerable` is the minimum shape every registry item must
// satisfy: `{ id, name, tags? }`. The historical `IdNameTagRegistry`
// has been deleted; consumers use `Registry<T>` directly with
// `duplicatePolicy: 'silent-skip'` + `nameCollisionMode: 'throw'`
// for the same dual-key semantics.
export { Registry } from './lib/registry.js';
export type {
  DuplicatePolicy,
  Registerable,
  RegistryOptions,
  RegisterCallOptions,
} from './lib/registry.js';

// RunScope — per-invocation execution scope. Owns the lifecycle of
// every singleton the codebase previously hung on module-level state
// (logger, caches, registries, recipe-config slot, project context,
// datastore thunk). See `lib/run-scope.ts` for the AsyncLocalStorage
// seam and the two-copies-of-fitness hazard resolution.
export {
  RunScope,
  runWithScope,
  runWithScopeSync,
  enterScope,
  exitScope,
  currentScope,
  currentLogger,
} from './lib/run-scope.js';
export type { RunScopeOptions } from './lib/run-scope.js';
// The Tool-contract scope types live in the leaf `scope-types.ts` so the
// `Tool` contract can depend on them without naming the concrete `RunScope`
// (breaks the RunScope⟷Tool type cycle; audit 2026-05-29 M4). Source them
// here directly from the leaf.
export type {
  RecipeUnitConfigSlot,
  DataStoreThunk,
  GraphCatalogThunk,
  ToolScope,
  ScopeContribution,
  ScopeContributionWithDisposer,
  ContributeScopeResult,
  ResolvedToolConfig,
  TargetResolver,
  TargetView,
} from './lib/scope-types.js';
export { isContributionWithDisposer } from './lib/scope-types.js';
