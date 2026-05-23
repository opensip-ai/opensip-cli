/**
 * @fileoverview Generic recipe registry — shared plumbing for fitness
 * and simulation recipe registries.
 *
 * Both fitness and simulation expose a "recipe" concept (a named bundle
 * of selectors + execution options). The registry data structure they
 * need is identical: a Map by id, a Map by name, register/lookup
 * helpers, and a guarded duplicate-id policy. Only the recipe service —
 * how a recipe's selector is resolved against the corresponding tool's
 * registry of checks/scenarios — legitimately differs between the two
 * tools, so the service stays per-package.
 *
 * `RecipeRegistry<T>` is parameterised over the concrete recipe shape,
 * which must minimally carry `id`, `name`, `displayName`, `description`,
 * and an optional `tags` array. The registry stores the full T objects;
 * tool-specific subclasses or wrappers add behaviour like override
 * tracking or built-in re-registration.
 *
 * Duplicate-id policy mirrors the kernel's `LanguageRegistry` /
 * `ToolRegistry` pattern from Layer 1 Phase 1: by default the second
 * `register` for the same id (or name) is rejected with a structured
 * `recipe.registry.duplicate` warning. Callers that legitimately want
 * to swap (e.g. user recipe overriding a built-in) opt in via
 * `register(recipe, { allowOverwrite: true })`. Throwing-on-duplicate
 * is also supported via `{ throwOnDuplicate: true }` for callers that
 * historically used that contract.
 */

import { ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/** Minimum shape any recipe must satisfy to live in a `RecipeRegistry`. */
export interface RecipeBase {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly tags?: readonly string[];
}

/** Options for a single `register` call. */
export interface RecipeRegisterOptions {
  /** Allow replacing an existing entry with the same id or name. */
  readonly allowOverwrite?: boolean;
  /**
   * Throw a `ValidationError` on duplicate id/name instead of the
   * default "warn-and-skip" behaviour. Use this for registries where
   * historical callers relied on a thrown error (e.g. user recipe
   * loaders that signal config errors via exceptions).
   */
  readonly throwOnDuplicate?: boolean;
  /**
   * Validation-error code surfaced when `throwOnDuplicate` fires.
   * Falls back to the registry's `validationCode` constructor option.
   */
  readonly validationCode?: string;
}

/** Constructor options for a `RecipeRegistry<T>`. */
export interface RecipeRegistryOptions {
  /** Human label used in log/throw messages — e.g. `'fitness'`, `'simulation'`. */
  readonly module?: string;
  /** Default validation error code on duplicate when `throwOnDuplicate` is set. */
  readonly validationCode?: string;
}

/**
 * Process-wide policy: duplicate id/name with `allowOverwrite: false`
 * keeps the first entry and emits a warning. Use `register(.., {
 * throwOnDuplicate: true })` to opt into the historical fitness/sim
 * "throw on duplicate" contract.
 */
export class RecipeRegistry<T extends RecipeBase> {
  protected readonly byId = new Map<string, T>();
  protected readonly byName = new Map<string, T>();
  private readonly module: string;
  private readonly validationCode: string;

  constructor(options: RecipeRegistryOptions = {}) {
    this.module = options.module ?? 'core:recipes';
    this.validationCode = options.validationCode ?? 'VALIDATION.RECIPE.DUPLICATE';
  }

  /**
   * Register a recipe.
   *
   * - Default: refuses on duplicate id/name; logs a `recipe.registry.duplicate` warning.
   * - `{ allowOverwrite: true }`: replaces the existing entry.
   * - `{ throwOnDuplicate: true }`: throws a `ValidationError` instead of warning.
   *   Mutually exclusive with `allowOverwrite`.
   */
  register(recipe: T, options: RecipeRegisterOptions = {}): void {
    const { allowOverwrite = false, throwOnDuplicate = false } = options;
    const incumbentById = this.byId.get(recipe.id);
    const incumbentByName = this.byName.get(recipe.name);
    const isDuplicate = incumbentById !== undefined || incumbentByName !== undefined;

    if (isDuplicate && !allowOverwrite) {
      if (throwOnDuplicate) {
        // @fitness-ignore-next-line result-pattern-consistency -- registration guard, throw is appropriate
        throw new ValidationError(
          `Recipe '${recipe.name}' (${recipe.id}) already registered`,
          { code: options.validationCode ?? this.validationCode },
        );
      }
      logger.warn({
        evt: 'recipe.registry.duplicate',
        module: this.module,
        id: recipe.id,
        name: recipe.name,
        msg: `Recipe ${recipe.name} (${recipe.id}) already registered — keeping incumbent`,
      });
      return;
    }

    // On allowOverwrite, ensure stale name/id mappings are cleared so
    // {byId, byName} stay consistent (e.g. a user recipe overriding a
    // built-in with a different id but the same name).
    if (incumbentById && incumbentById.name !== recipe.name) {
      this.byName.delete(incumbentById.name);
    }
    if (incumbentByName && incumbentByName.id !== recipe.id) {
      this.byId.delete(incumbentByName.id);
    }
    this.byId.set(recipe.id, recipe);
    this.byName.set(recipe.name, recipe);
  }

  /** Register many recipes with shared options. */
  registerAll(recipes: readonly T[], options: RecipeRegisterOptions = {}): void {
    for (const recipe of recipes) {
      this.register(recipe, options);
    }
  }

  /** Look up a recipe by name first, falling back to id. */
  loadRecipe(nameOrId: string): T | undefined {
    return this.byName.get(nameOrId) ?? this.byId.get(nameOrId);
  }

  getByName(name: string): T | undefined {
    return this.byName.get(name);
  }

  getById(id: string): T | undefined {
    return this.byId.get(id);
  }

  has(nameOrId: string): boolean {
    return this.byName.has(nameOrId) || this.byId.has(nameOrId);
  }

  /** All registered recipes, in registration order. */
  getAllRecipes(): readonly T[] {
    return [...this.byId.values()];
  }

  /** All registered recipe names, in registration order. */
  getNames(): readonly string[] {
    return [...this.byName.keys()];
  }

  /** Recipes with a given tag. */
  getByTag(tag: string): readonly T[] {
    return [...this.byId.values()].filter((r) => r.tags?.includes(tag));
  }

  get size(): number {
    return this.byId.size;
  }

  /** Remove a recipe by id. Returns true if it existed. */
  remove(id: string): boolean {
    const recipe = this.byId.get(id);
    if (!recipe) return false;
    this.byId.delete(id);
    this.byName.delete(recipe.name);
    return true;
  }

  /** Drop every entry. */
  clear(): void {
    this.byId.clear();
    this.byName.clear();
  }
}
