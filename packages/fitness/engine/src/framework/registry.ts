/**
 * Check registry — central registration and discovery.
 *
 * Supports namespaced slugs: checks are stored as `namespace:slug` when
 * a namespace is provided. Bare slug lookups resolve via a reverse index,
 * with a warning logged on ambiguity.
 */

import type { Check } from './check-types.js';
import { NotFoundError } from '@opensip-tools/core';
import { logger } from '@opensip-tools/core';

export type { Check };

export class CheckRegistry {
  /** Primary store: key is `namespace:slug` or bare `slug` */
  private readonly checks = new Map<string, Check>();
  /** Reverse index: bare slug → list of namespaced keys */
  private readonly bareSlugIndex = new Map<string, string[]>();

  register(check: Check, namespace?: string): void {
    const bareSlug = check.config.slug;
    const key = namespace ? `${namespace}:${bareSlug}` : bareSlug;

    if (this.checks.has(key)) {
      // Silently skip duplicate — same check imported multiple times
      return;
    }

    this.checks.set(key, check);

    // Update bare slug index
    const existing = this.bareSlugIndex.get(bareSlug) ?? [];
    existing.push(key);
    this.bareSlugIndex.set(bareSlug, existing);
  }

  /** Get a check by slug. Supports both namespaced and bare slugs. */
  get(slug: string): Check {
    const check = this.resolve(slug);
    if (!check) throw new NotFoundError(`Check not found: ${slug}`);
    return check;
  }

  /** Check whether a slug is registered (namespaced or bare). */
  has(slug: string): boolean {
    return this.resolve(slug) !== undefined;
  }

  list(): Check[] {
    return [...this.checks.values()];
  }

  /** Get the namespace a check was registered under. Returns undefined for bare slugs. */
  getNamespace(bareSlug: string): string | undefined {
    const keys = this.bareSlugIndex.get(bareSlug);
    if (!keys || keys.length === 0) return undefined;
    const key = keys[0];
    const colonIdx = key.indexOf(':');
    return colonIdx >= 0 ? key.slice(0, colonIdx) : undefined;
  }

  listEnabled(): Check[] {
    return this.list().filter(c => !c.config.disabled);
  }

  byTag(tag: string): Check[] {
    return this.listEnabled().filter(c => c.config.tags?.includes(tag));
  }

  /** Get a check by slug, returning undefined if not found. */
  getBySlug(slug: string): Check | undefined {
    return this.resolve(slug);
  }

  /** Return all registered keys (namespaced where applicable). */
  listSlugs(): string[] {
    return [...this.checks.keys()];
  }

  /** Return all checks with a given bare slug across all namespaces. */
  listByBareSlug(bareSlug: string): Check[] {
    const keys = this.bareSlugIndex.get(bareSlug) ?? [];
    return keys.map(k => this.checks.get(k)).filter((c): c is Check => c !== undefined);
  }

  get size(): number {
    return this.checks.size;
  }

  /**
   * Resolve a slug to a Check.
   * - If slug contains ':', exact lookup.
   * - If bare slug, use reverse index. Single match → return. Multiple → warn + return first.
   */
  private resolve(slug: string): Check | undefined {
    // Exact match (namespaced or bare)
    const exact = this.checks.get(slug);
    if (exact) return exact;

    // If it contains ':', it was a namespaced lookup that didn't match
    if (slug.includes(':')) return undefined;

    // Bare slug → reverse index
    const candidates = this.bareSlugIndex.get(slug);
    if (!candidates || candidates.length === 0) return undefined;

    if (candidates.length > 1) {
      logger.warn({
        evt: 'plugin.registry.collision',
        module: 'core:registry',
        bareSlug: slug,
        candidates,
        msg: `Ambiguous slug '${slug}' matches ${candidates.length} checks — using first registered`,
      });
    }

    return this.checks.get(candidates[0]!);
  }
}

/** Default global registry — checks auto-register here on import */
export const defaultRegistry = new CheckRegistry();
