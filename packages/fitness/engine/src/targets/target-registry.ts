/**
 * @fileoverview Fitness Target Registry
 *
 * The generic register/get/byTag/has substrate moved to
 * `@opensip-cli/targeting` (ADR-0037, Phase 0). This fitness registry is a
 * thin **subclass** that adds only the check-domain `findByScope` (languages +
 * concerns intersection) — `concerns` is a check-scope concept, so it stays in
 * fitness, not the host substrate.
 *
 * Subclassing keeps every fitness call site (`registry.getByName`,
 * `registry.has`, `registry.getAll`, `registry.findByScope`) working unchanged
 * while the generic surface lives once, in the substrate.
 */

import { currentScope } from '@opensip-cli/core';
import { TargetRegistry as SubstrateTargetRegistry } from '@opensip-cli/targeting';

import type { Target } from './types.js';

/**
 * Map a language string (canonical id or alias) to its canonical adapter id.
 * Falls back to a lowercased copy when the language isn't registered, so
 * scope-matching still treats unknown ids as themselves rather than
 * losing them entirely. Falls back to lowercase also when no scope is
 * bound (test contexts that don't wire a scope) — preserves prior behaviour
 * of treating unknown adapters as themselves.
 */
function toCanonical(lang: string): string {
  return currentScope()?.languages.canonicalize(lang) ?? lang.toLowerCase();
}

/**
 * Fitness target registry: the substrate registry plus the check-domain
 * scope-matching `findByScope`. IS-A {@link SubstrateTargetRegistry}, so every
 * generic lookup (`register`/`getByName`/`getAll`/`getByTag`/`has`/`size`/
 * `clear`) is inherited unchanged.
 */
export class TargetRegistry extends SubstrateTargetRegistry {
  /**
   * Find targets whose languages and concerns intersect with the given scope.
   *
   * Both dimensions must match (AND logic):
   * - A target matches languages if the intersection is non-empty (or either side is empty/undefined)
   * - A target matches concerns if the intersection is non-empty (or either side is empty/undefined)
   *
   * Language strings are canonicalised on both sides through
   * the scope's `languages.canonicalize`, so a target written
   * with `languages: ['c']` matches a check scoped to `cpp`, and a
   * target with `languages: ['rs']` matches `rust`-scoped checks.
   *
   * @param languages - Languages the check is designed for
   * @param concerns - Semantic concerns the check targets
   * @returns Targets that match both dimensions
   */
  findByScope(languages: readonly string[], concerns: readonly string[]): readonly Target[] {
    const scopeLangs = languages.map(toCanonical);
    return this.getAll().filter((target) => {
      const targetLangs = target.config.languages;
      const targetConcerns = target.config.concerns;
      const targetLangsCanonical = targetLangs?.map(toCanonical);

      // Language matching: if either side has no languages, treat as "matches any"
      const languageMatch =
        scopeLangs.length === 0 ||
        !targetLangsCanonical ||
        targetLangsCanonical.length === 0 ||
        scopeLangs.some((lang) => targetLangsCanonical.includes(lang));

      // Concern matching: if either side has no concerns, treat as "matches any"
      const concernMatch =
        concerns.length === 0 ||
        !targetConcerns ||
        targetConcerns.length === 0 ||
        concerns.some((concern) => targetConcerns.includes(concern));

      return languageMatch && concernMatch;
    });
  }
}
