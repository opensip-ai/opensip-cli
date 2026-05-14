/**
 * @fileoverview Target Registry
 *
 * Registry for target definitions. Provides lookup by name and tags.
 * Standalone implementation without platform GenericRegistry dependency.
 *
 * The entire targets module uses a synchronous API because target definitions
 * are loaded once at startup from a small YAML config file (via loader.ts) and
 * then held in-memory for fast, repeated lookups throughout the process lifetime.
 * The resolver (resolver.ts) similarly uses synchronous glob expansion. Since the
 * data set is small and bounded by project configuration, async I/O offers no
 * practical benefit and would complicate every call site that queries targets.
 */

import type { Target } from './types.js'

/** Registry for target definitions with lookup by name and tags. */
export class TargetRegistry {
  private readonly targets = new Map<string, Target>()

  /**
   * Register a target. Silently skips if a target with the same name already exists.
   * @param target - Target definition to register
   * @returns This registry instance for chaining
   */
  register(target: Target): this {
    const name = target.config.name

    if (this.targets.has(name)) {
      return this
    }

    this.targets.set(name, target)
    return this
  }

  /**
   * Look up a target by its config name.
   * @param name - Target name to find
   * @returns The matching target, or undefined if not found
   */
  getByName(name: string): Target | undefined {
    return this.targets.get(name)
  }

  /** Return all registered targets. */
  getAll(): readonly Target[] {
    return [...this.targets.values()]
  }

  /**
   * Return all targets that include the given tag.
   * @param tag - Tag string to filter by
   * @returns Targets whose config.tags contain the tag
   */
  getByTag(tag: string): readonly Target[] {
    return this.getAll().filter((t) => t.config.tags?.includes(tag))
  }

  /**
   * Check whether a target with the given name is registered.
   * @param name - Target name to check
   * @returns True if the target exists in the registry
   */
  has(name: string): boolean {
    return this.targets.has(name)
  }

  /**
   * Find targets whose languages and concerns intersect with the given scope.
   *
   * Both dimensions must match (AND logic):
   * - A target matches languages if the intersection is non-empty (or either side is empty/undefined)
   * - A target matches concerns if the intersection is non-empty (or either side is empty/undefined)
   *
   * @param languages - Languages the check is designed for
   * @param concerns - Semantic concerns the check targets
   * @returns Targets that match both dimensions
   */
  findByScope(languages: readonly string[], concerns: readonly string[]): readonly Target[] {
    return this.getAll().filter((target) => {
      const targetLangs = target.config.languages
      const targetConcerns = target.config.concerns

      // Language matching: if either side has no languages, treat as "matches any"
      const languageMatch =
        languages.length === 0 ||
        !targetLangs || targetLangs.length === 0 ||
        languages.some((lang) => targetLangs.includes(lang))

      // Concern matching: if either side has no concerns, treat as "matches any"
      const concernMatch =
        concerns.length === 0 ||
        !targetConcerns || targetConcerns.length === 0 ||
        concerns.some((concern) => targetConcerns.includes(concern))

      return languageMatch && concernMatch
    })
  }

  /** Number of registered targets. */
  get size(): number {
    return this.targets.size
  }

  /** Remove all targets from the registry. */
  clear(): void {
    this.targets.clear()
  }
}

/** Singleton target registry instance. */
export const defaultTargetRegistry = new TargetRegistry()
