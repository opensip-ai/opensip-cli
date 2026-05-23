/**
 * @fileoverview Generic id+name+tag registry — the smaller "common ancestor"
 * underlying `LanguageRegistry`, `ToolRegistry`, and the simulation scenario
 * registry.
 *
 * `RecipeRegistry<T>` (in `core/recipes/registry.ts`) requires recipes to
 * carry `displayName` / `description` and applies a richer
 * warn-and-skip-vs-throw-vs-overwrite policy. Many other registry consumers
 * just need a plain dual-key (id + name) store with optional tag filtering
 * and a single duplicate-handling mode. `IdNameTagRegistry<T>` is that
 * smaller surface, parameterised over any `Registerable` shape.
 *
 * Duplicate policy: same-id re-registration is silently ignored (so a
 * loader-test pattern that re-registers the same scenario many times does
 * not need to deduplicate at the call site). A name collision with a
 * different id is rejected with a `ValidationError` because the byId/byName
 * indices would otherwise diverge.
 */

import { ValidationError } from './errors.js';

/** Minimum shape any item must satisfy to live in an `IdNameTagRegistry`. */
export interface Registerable {
  readonly id: string;
  readonly name: string;
  readonly tags?: readonly string[];
}

/** A small generic registry with id + name lookup and tag filtering. */
export class IdNameTagRegistry<T extends Registerable> {
  private readonly byId = new Map<string, T>();
  private readonly byName = new Map<string, T>();
  private readonly moduleName: string;

  constructor(moduleName: string) {
    this.moduleName = moduleName;
  }

  register(item: T): void {
    if (this.byId.has(item.id)) return; // Skip duplicates silently

    // Guard against name collisions: two items with different IDs but same name
    // would cause inconsistent dual-key state (byId has both, byName only has last)
    const existingByName = this.byName.get(item.name);
    if (existingByName && existingByName.id !== item.id) {
      // @fitness-ignore-next-line result-pattern-consistency -- registration guard, throw is appropriate
      throw new ValidationError(
        `${this.moduleName} registry: name collision — '${item.name}' is already registered with id '${existingByName.id}', cannot register id '${item.id}' with the same name`,
        { code: 'VALIDATION.REGISTRY.NAME_COLLISION' },
      );
    }

    this.byId.set(item.id, item);
    this.byName.set(item.name, item);
  }

  get(idOrName: string): T | undefined {
    return this.byId.get(idOrName) ?? this.byName.get(idOrName);
  }

  has(idOrName: string): boolean {
    return this.byId.has(idOrName) || this.byName.has(idOrName);
  }

  getAll(): T[] {
    return [...this.byId.values()];
  }

  getByTag(tag: string): T[] {
    return this.getAll().filter((item) => item.tags?.includes(tag));
  }

  get size(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
    this.byName.clear();
  }
}
