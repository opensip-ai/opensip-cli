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
 * Implemented on top of the kernel's unified `Registry<T>` base.
 * `RecipeRegistry<T>` provides the `allowOverwrite + throwOnDuplicate`
 * flag pair as a per-call modulation layer on top of the configured
 * `'warn-first-wins'` default — preserving the historical surface so
 * Phase 2 can migrate without touching consumers. The flag pair is
 * retired in a follow-up once the consumers are simplified.
 *
 * **Temporary `protected byId`/`byName` shim:** Phase 0 Task 0.1's
 * audit revealed that BOTH `FitnessRecipeRegistry` and
 * `SimulationRecipeRegistry` write directly to these maps in their
 * `registerBuiltInRecipes` methods (the canonical LSP violation that
 * motivated the union refactor). The shim survives Phase 2 and is
 * removed in Phase 3 Task 3.4 once both subclasses switch to
 * `registerAll(builtIns, { internal: true })`.
 */

import { ValidationError } from '../lib/errors.js';
import { Registry, type Registerable } from '../lib/registry.js';

import type { Logger } from '../lib/logger.js';

/** Minimum shape any recipe must satisfy to live in a `RecipeRegistry`. */
export interface RecipeBase extends Registerable {
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
  /**
   * Bypass the duplicate guard for this call. Used by built-in
   * seeding paths in `FitnessRecipeRegistry` / `SimulationRecipeRegistry`
   * after Phase 3 lands; not part of the public surface for user code.
   */
  readonly internal?: boolean;
}

/** Constructor options for a `RecipeRegistry<T>`. */
export interface RecipeRegistryOptions {
  /** Human label used in log/throw messages — e.g. `'fitness'`, `'simulation'`. */
  readonly module?: string;
  /** Default validation error code on duplicate when `throwOnDuplicate` is set. */
  readonly validationCode?: string;
  readonly logger?: Logger;
}

/**
 * A Map-shaped proxy that delegates reads to a `Registry<T>` and
 * routes writes through `inner.register(item, { internal: true })`.
 * Exists ONLY to support the temp `protected byId` / `byName` shim
 * that `FitnessRecipeRegistry` and `SimulationRecipeRegistry` need
 * until Phase 3 removes their direct map writes.
 *
 * Reads ALL delegate to the inner registry — so `listForDisplay()`
 * reading via `[...this.byId.values()]` correctly sees both
 * built-ins (added via `byId.set(...)`) AND user registrations
 * (added via `register()` → `inner.register()`).
 */
class RegistryMirrorMap<T extends RecipeBase> extends Map<string, T> {
  private readonly inner: Registry<T>;
  private readonly indexBy: 'id' | 'name';

  constructor(inner: Registry<T>, indexBy: 'id' | 'name') {
    super();
    this.inner = inner;
    this.indexBy = indexBy;
  }

  override set(key: string, value: T): this {
    // Route the write through the inner registry; { internal: true }
    // bypasses the duplicate guard so successive built-in seeds in
    // the subclass constructors don't trip the warn-first-wins policy.
    this.inner.register(value, { internal: true });
    return this;
  }

  override get(key: string): T | undefined {
    return this.indexBy === 'id' ? this.inner.getById(key) : this.inner.getByName(key);
  }

  override has(key: string): boolean {
    const item = this.indexBy === 'id' ? this.inner.getById(key) : this.inner.getByName(key);
    return item !== undefined;
  }

  override delete(key: string): boolean {
    // Subclasses don't delete from these maps in production; Phase 3
    // removes the shim entirely. The implementation routes through
    // inner.remove for completeness.
    if (this.indexBy === 'id') return this.inner.remove(key);
    const item = this.inner.getByName(key);
    if (!item) return false;
    return this.inner.remove(item.id);
  }

  override clear(): void {
    // Subclasses' `reset()` calls `this.clear()` on the RecipeRegistry
    // (public API), which goes through `inner.clear()`. This map
    // doesn't own storage; nothing to clear.
  }

  override get size(): number {
    return this.inner.size;
  }

  override values(): MapIterator<T> {
    return (this.inner.getAll() as T[])[Symbol.iterator]();
  }

  override keys(): MapIterator<string> {
    const items = this.inner.getAll();
    const keys = this.indexBy === 'id' ? items.map((i) => i.id) : items.map((i) => i.name);
    return keys[Symbol.iterator]();
  }

  override entries(): MapIterator<[string, T]> {
    const items = this.inner.getAll();
    const entries: [string, T][] = items.map((i) => [
      this.indexBy === 'id' ? i.id : i.name,
      i,
    ]);
    return entries[Symbol.iterator]();
  }

  override [Symbol.iterator](): MapIterator<[string, T]> {
    return this.entries();
  }

  override forEach(
    callbackfn: (value: T, key: string, map: Map<string, T>) => void,
    thisArg?: unknown,
  ): void {
    for (const [k, v] of this.entries()) {
      callbackfn.call(thisArg, v, k, this);
    }
  }
}

/**
 * Process-wide policy: duplicate id/name with `allowOverwrite: false`
 * keeps the first entry and emits a warning. Use `register(.., {
 * throwOnDuplicate: true })` to opt into the historical fitness/sim
 * "throw on duplicate" contract.
 */
export class RecipeRegistry<T extends RecipeBase> {
  protected readonly inner: Registry<T>;
  private readonly module: string;
  private readonly validationCode: string;

  /**
   * TEMP SHIM (Phase 2 Task 2.3) — `FitnessRecipeRegistry` and
   * `SimulationRecipeRegistry` write directly to these Maps in
   * their built-in seed paths. Phase 3 Tasks 3.2 + 3.4 replace those
   * direct writes with `registerAll(builtIns, { internal: true })`
   * and remove this shim. Do NOT use in new code.
   */
  protected readonly byId: RegistryMirrorMap<T>;
  /** TEMP SHIM — see {@link byId}. */
  protected readonly byName: RegistryMirrorMap<T>;

  constructor(options: RecipeRegistryOptions = {}) {
    this.module = options.module ?? 'core:recipes';
    this.validationCode = options.validationCode ?? 'VALIDATION.RECIPE.DUPLICATE';
    this.inner = new Registry<T>({
      module: this.module,
      duplicatePolicy: 'warn-first-wins',
      evtPrefix: 'recipe.registry',
      validationCode: this.validationCode,
      logger: options.logger,
    });
    // Temp shim — wired so subclass writes (`this.byId.set(id, r)`)
    // route through `inner.register(r, { internal: true })`. Reads
    // delegate back to inner so user registrations via `register()`
    // are visible through `this.byId.values()` too.
    this.byId = new RegistryMirrorMap<T>(this.inner, 'id');
    this.byName = new RegistryMirrorMap<T>(this.inner, 'name');
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
    const { allowOverwrite = false, throwOnDuplicate = false, internal = false } = options;
    if (allowOverwrite && throwOnDuplicate) {
      // The two flags advertise contradictory behaviours; honour the
      // JSDoc claim of mutual exclusion at runtime so a defensive
      // caller that sets both doesn't silently get the overwrite
      // path with no diagnostic.
      // @fitness-ignore-next-line result-pattern-consistency -- registration guard, throw is appropriate
      throw new ValidationError(
        `RecipeRegistry.register: 'allowOverwrite' and 'throwOnDuplicate' are mutually exclusive`,
        { code: options.validationCode ?? this.validationCode },
      );
    }
    if (internal) {
      this.inner.register(recipe, { internal: true });
      return;
    }
    if (allowOverwrite) {
      // Overwrite path: clean up stale name/id mappings and re-insert.
      const incumbentById = this.inner.getById(recipe.id);
      const incumbentByName = this.inner.getByName(recipe.name);
      if (incumbentById && incumbentById.name !== recipe.name) {
        this.inner.remove(incumbentById.id);
      }
      if (incumbentByName && incumbentByName.id !== recipe.id) {
        this.inner.remove(incumbentByName.id);
      }
      this.inner.register(recipe, { internal: true });
      return;
    }
    if (throwOnDuplicate) {
      const dup =
        this.inner.has(recipe.id) ||
        (this.inner.has(recipe.name) && this.inner.getByName(recipe.name)?.id !== recipe.id);
      if (dup) {
        // @fitness-ignore-next-line result-pattern-consistency -- registration guard, throw is appropriate
        throw new ValidationError(
          `Recipe '${recipe.name}' (${recipe.id}) already registered`,
          { code: options.validationCode ?? this.validationCode },
        );
      }
      this.inner.register(recipe, { internal: true });
      return;
    }
    // Default warn-first-wins via the inner base.
    this.inner.register(recipe);
  }

  /** Register many recipes with shared options. */
  registerAll(recipes: readonly T[], options: RecipeRegisterOptions = {}): void {
    for (const recipe of recipes) {
      this.register(recipe, options);
    }
  }

  /** Look up a recipe by name first, falling back to id. */
  loadRecipe(nameOrId: string): T | undefined {
    return this.inner.getByName(nameOrId) ?? this.inner.getById(nameOrId);
  }

  getByName(name: string): T | undefined {
    return this.inner.getByName(name);
  }

  getById(id: string): T | undefined {
    return this.inner.getById(id);
  }

  has(nameOrId: string): boolean {
    return this.inner.has(nameOrId);
  }

  /** All registered recipes, in registration order. */
  getAllRecipes(): readonly T[] {
    return this.inner.getAll();
  }

  /** All registered recipe names, in registration order. */
  getNames(): readonly string[] {
    return this.inner.getAll().map((r) => r.name);
  }

  /** Recipes with a given tag. */
  getByTag(tag: string): readonly T[] {
    return this.inner.getByTag(tag);
  }

  get size(): number {
    return this.inner.size;
  }

  /** Remove a recipe by id. Returns true if it existed. */
  remove(id: string): boolean {
    return this.inner.remove(id);
  }

  /** Drop every entry. */
  clear(): void {
    this.inner.clear();
  }
}
