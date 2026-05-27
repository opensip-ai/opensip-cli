/**
 * @fileoverview Target Registry
 *
 * Registry for target definitions. Provides lookup by name and tags.
 *
 * Built on the kernel's unified `Registry<T>` with `silent-skip` —
 * registering a target with a name that's already taken is a no-op
 * (the historical behaviour).
 *
 * The entire targets module uses a synchronous API because target definitions
 * are loaded once at startup from a small YAML config file (via loader.ts) and
 * then held in-memory for fast, repeated lookups throughout the process lifetime.
 * The resolver (resolver.ts) similarly uses synchronous glob expansion. Since the
 * data set is small and bounded by project configuration, async I/O offers no
 * practical benefit and would complicate every call site that queries targets.
 */

import { Registry, defaultLanguageRegistry, type Registerable } from '@opensip-tools/core'

import type { Target } from './types.js'

/**
 * Map a language string (canonical id or alias) to its canonical adapter id.
 * Falls back to a lowercased copy when the language isn't registered, so
 * scope-matching still treats unknown ids as themselves rather than
 * losing them entirely.
 */
function toCanonical(lang: string): string {
  return defaultLanguageRegistry.canonicalize(lang) ?? lang.toLowerCase()
}

interface RegisterableTarget extends Registerable {
  readonly id: string;   // same as target.config.name (Target has no id today)
  readonly name: string;
  readonly target: Target;
  readonly tags?: readonly string[];
}

/** Registry for target definitions with lookup by name and tags. */
export class TargetRegistry {
  private readonly inner = new Registry<RegisterableTarget>({
    module: 'fitness:targets',
    duplicatePolicy: 'silent-skip',
    evtPrefix: 'target.registry',
  })

  /**
   * Register a target. Silently skips if a target with the same name already exists.
   * @param target - Target definition to register
   * @returns This registry instance for chaining
   */
  register(target: Target): this {
    const name = target.config.name
    this.inner.register({
      id: name,
      name,
      target,
      tags: target.config.tags,
    })
    return this
  }

  /**
   * Look up a target by its config name.
   * @param name - Target name to find
   * @returns The matching target, or undefined if not found
   */
  getByName(name: string): Target | undefined {
    return this.inner.getById(name)?.target
  }

  /** Return all registered targets. */
  getAll(): readonly Target[] {
    return this.inner.getAll().map((r) => r.target)
  }

  /**
   * Return all targets that include the given tag.
   * @param tag - Tag string to filter by
   * @returns Targets whose config.tags contain the tag
   */
  getByTag(tag: string): readonly Target[] {
    return this.inner.getByTag(tag).map((r) => r.target)
  }

  /**
   * Check whether a target with the given name is registered.
   * @param name - Target name to check
   * @returns True if the target exists in the registry
   */
  has(name: string): boolean {
    return this.inner.has(name)
  }

  /**
   * Find targets whose languages and concerns intersect with the given scope.
   *
   * Both dimensions must match (AND logic):
   * - A target matches languages if the intersection is non-empty (or either side is empty/undefined)
   * - A target matches concerns if the intersection is non-empty (or either side is empty/undefined)
   *
   * Language strings are canonicalised on both sides through
   * {@link defaultLanguageRegistry.canonicalize}, so a target written
   * with `languages: ['c']` matches a check scoped to `cpp`, and a
   * target with `languages: ['rs']` matches `rust`-scoped checks.
   *
   * @param languages - Languages the check is designed for
   * @param concerns - Semantic concerns the check targets
   * @returns Targets that match both dimensions
   */
  findByScope(languages: readonly string[], concerns: readonly string[]): readonly Target[] {
    const scopeLangs = languages.map(toCanonical)
    return this.getAll().filter((target) => {
      const targetLangs = target.config.languages
      const targetConcerns = target.config.concerns
      const targetLangsCanonical = targetLangs?.map(toCanonical)

      // Language matching: if either side has no languages, treat as "matches any"
      const languageMatch =
        scopeLangs.length === 0 ||
        !targetLangsCanonical || targetLangsCanonical.length === 0 ||
        scopeLangs.some((lang) => targetLangsCanonical.includes(lang))

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
    return this.inner.size
  }

  /** Remove all targets from the registry. */
  clear(): void {
    this.inner.clear()
  }
}
