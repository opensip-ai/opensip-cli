/**
 * Check registry — central registration and discovery.
 *
 * Supports namespaced slugs: checks are stored as `namespace:slug` when
 * a namespace is provided. Bare slug lookups resolve via a reverse index,
 * with a warning logged on ambiguity.
 *
 * Built on the kernel's unified `Registry<T>` with
 * `duplicatePolicy: 'silent-skip'` — re-importing the same check is a
 * no-op (the historical behaviour the file's previous incarnation
 * documented). The `bareSlugIndex` (slug → list of namespaced keys)
 * lives alongside the base because it's a domain-specific lookup
 * structure not in the base's shape.
 */

import { NotFoundError, Registry, logger, type Registerable } from '@opensip-cli/core';

import type { Check } from './check-types.js';

interface RegisterableCheck extends Registerable {
  readonly id: string; // key: `namespace:slug` or bare slug
  readonly name: string; // same as id (Check has no separate name)
  readonly check: Check;
  readonly tags?: readonly string[];
}

/** Registry of fitness checks, indexed by namespaced key with a bare-slug reverse index. */
export class CheckRegistry {
  private readonly inner = new Registry<RegisterableCheck>({
    module: 'fitness:checks',
    duplicatePolicy: 'silent-skip',
    evtPrefix: 'check.registry',
  });
  /** Reverse index: bare slug → list of namespaced keys */
  private readonly bareSlugIndex = new Map<string, string[]>();

  register(check: Check, namespace?: string): void {
    const bareSlug = check.config.slug;
    const key = namespace ? `${namespace}:${bareSlug}` : bareSlug;

    if (this.inner.has(key)) {
      // Silently skip duplicate — same check imported multiple times.
      // Inner's silent-skip policy would do this anyway; we short-circuit
      // here to avoid the redundant index update.
      return;
    }

    this.inner.register({ id: key, name: key, check, tags: check.config.tags });

    // Update bare slug index
    const existing = this.bareSlugIndex.get(bareSlug) ?? [];
    existing.push(key);
    this.bareSlugIndex.set(bareSlug, existing);
  }

  /** Get a check by slug. Supports both namespaced and bare slugs. */
  get(slug: string): Check {
    const check = this.resolve(slug);
    if (!check) {
      const cands = slug.includes(':') ? [] : (this.bareSlugIndex.get(slug) ?? []);
      if (cands.length > 1) {
        throw new NotFoundError(
          `Check slug '${slug}' is ambiguous (${cands.length} matches: ${cands.join(', ')}). ` +
            `Use a namespaced form (e.g. 'namespace:${slug}') or listByBareSlug().`,
        );
      }
      throw new NotFoundError(`Check not found: ${slug}`);
    }
    return check;
  }

  /** Check whether a slug is registered (namespaced or bare). */
  has(slug: string): boolean {
    return this.resolve(slug) !== undefined;
  }

  /** Get a check by slug, or `undefined` if not registered (non-throwing {@link get}). */
  find(slug: string): Check | undefined {
    return this.resolve(slug);
  }

  list(): Check[] {
    return this.inner.getAll().map((r) => r.check);
  }

  /** Get the namespace a check was registered under. Returns undefined for bare slugs. */
  getNamespace(bareSlug: string): string | undefined {
    const keys = this.bareSlugIndex.get(bareSlug);
    if (!keys || keys.length === 0) return undefined;
    const key = keys[0];
    const colonIdx = key.indexOf(':');
    return colonIdx === -1 ? undefined : key.slice(0, colonIdx);
  }

  listEnabled(): Check[] {
    return this.list().filter((c) => !c.config.disabled);
  }

  byTag(tag: string): Check[] {
    return this.listEnabled().filter((c) => c.config.tags?.includes(tag));
  }

  /** Get a check by slug, returning undefined if not found. */
  getBySlug(slug: string): Check | undefined {
    return this.resolve(slug);
  }

  /** Return all registered keys (namespaced where applicable). */
  listSlugs(): string[] {
    return this.inner.getAll().map((r) => r.id);
  }

  /** Return all checks with a given bare slug across all namespaces. */
  listByBareSlug(bareSlug: string): Check[] {
    const keys = this.bareSlugIndex.get(bareSlug) ?? [];
    return keys.map((k) => this.inner.getById(k)?.check).filter((c): c is Check => c !== undefined);
  }

  /**
   * Resolve a slug to its canonical registry key (fail-closed on ambiguity).
   *
   * - Exact registry keys (namespaced or bare) are returned unchanged.
   * - A namespaced ref whose exact key is NOT registered (e.g. a built-in
   *   recipe's `@opensip-cli/checks-universal:no-console-log` against a
   *   bare-registered first-party check) falls back to its bare slug — still
   *   fail-closed if that bare slug is genuinely ambiguous.
   * - Bare slugs resolve via the reverse index; multiple matches return
   *   `undefined` and emit `check.registry.ambiguous` (mirrors {@link resolve}).
   * - Unknown slugs return `undefined`.
   */
  resolveBareSlug(slug: string): string | undefined {
    if (this.inner.has(slug)) return slug;

    // Reduce a non-exact namespaced ref to its bare slug; a bare slug is used
    // as-is. The pack prefix is advisory when the exact key isn't registered.
    const bareSlug = slug.includes(':') ? (slug.split(':').pop() ?? slug) : slug;
    if (bareSlug !== slug && this.inner.has(bareSlug)) return bareSlug;

    const candidates = this.bareSlugIndex.get(bareSlug);
    if (!candidates || candidates.length === 0) return undefined;

    if (candidates.length > 1) {
      logger.warn({
        evt: 'check.registry.ambiguous',
        module: 'fitness:checks',
        bareSlug,
        candidates,
        msg: `Ambiguous bare slug '${bareSlug}' matches ${candidates.length} checks (namespaced); refusing bare lookup`,
      });
      return undefined;
    }

    return candidates[0];
  }

  get size(): number {
    return this.inner.size;
  }

  /**
   * Resolve a slug to a Check.
   * - If slug contains ':', exact lookup.
   * - If bare slug, use reverse index. Single match → return.
   *   Multiple candidates → throw NotFoundError listing them (ambiguity is
   *   now a hard failure rather than load-order-dependent silent choice of [0]).
   *   Use listByBareSlug() when enumeration of all is desired.
   */
  private resolve(slug: string): Check | undefined {
    // Exact match (namespaced or bare)
    const exact = this.inner.getById(slug);
    if (exact) return exact.check;

    // If it contains ':', it was a namespaced lookup that didn't match
    if (slug.includes(':')) return undefined;

    // Bare slug → reverse index
    const candidates = this.bareSlugIndex.get(slug);
    if (!candidates || candidates.length === 0) return undefined;

    if (candidates.length > 1) {
      // Hard failure on ambiguity — prevents non-deterministic "which check won?"
      // behaviour across pack load order or plugin discovery. Callers that want
      // the full list can use listByBareSlug().
      logger.warn({
        evt: 'check.registry.ambiguous',
        module: 'fitness:checks',
        bareSlug: slug,
        candidates,
        msg: `Ambiguous bare slug '${slug}' matches ${candidates.length} checks (namespaced); refusing bare lookup`,
      });
      return undefined; // get() will turn this into a NotFoundError with the slug
    }

    return this.inner.getById(candidates[0])?.check;
  }
}

export { type Check } from './check-types.js';
