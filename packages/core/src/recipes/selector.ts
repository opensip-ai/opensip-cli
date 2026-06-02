/**
 * @fileoverview Generic recipe selector union + resolver — the selection
 * half of the recipe substrate (the registry half lives in `./registry.ts`).
 *
 * A recipe selects a named subset of registered units (checks today,
 * scenarios, rules later). The four common selection shapes —
 * `explicit` / `all` / `tags` / `pattern` — are structurally identical
 * across tools; only unit-specific fields (e.g. fitness `config`, sim
 * `kind`) diverge. This module owns the shared union and a resolver
 * generic over the kernel `Registerable` surface (`id` / `name` / `tags`).
 *
 * **Layer-safe by construction.** Core never names a tool type or pulls a
 * tool dependency. Everything tool-specific arrives injected:
 *   - `keysOf(item)` — the match keys an item exposes (fitness: namespaced
 *     slug + bare slug + tag/slug targets; sim: `[id, name]`).
 *   - `match(target, pattern)` — the glob matcher for the `pattern` arm
 *     (fitness injects `minimatch`; `minimatch` stays out of core).
 *   - `resolveExplicit(id, items)` — a tool's fallback lookup for an
 *     explicit id that is not itself a primary key (fitness's
 *     bare-slug → namespaced-key resolution).
 *   - `predicates` — a per-arm predicate map for arms core cannot name
 *     (sim's `kind`) **or** arms whose semantics differ from core's
 *     built-in (sim's `tags`, which excludes on id/name rather than tags).
 *
 * **Selection only, never execution.** The resolver returns the selected
 * items; each tool's service consumes them with its own scheduler. This
 * is the load-bearing seam the symmetric-tool architecture (ADR-0005)
 * draws — execution stays tool-owned.
 *
 * **`tags` semantics.** Core's built-in `tags` arm intersects an item's
 * tags with `include` and rejects on `exclude` (matching fitness's
 * `resolveTagsSelector`). A tool whose `tags` arm means something else
 * (sim excludes on id/name) supplies a `tags` predicate instead, which
 * overrides the built-in arm — see `predicates` below.
 */

import { SystemError } from '../lib/errors.js';

import type { Registerable } from '../lib/registry.js';
import type { RecipeUnitConfigMap } from './unit-config.js';

/** Select an explicit, ordered list of units by id. */
export interface ExplicitSelector {
  readonly type: 'explicit';
  readonly ids: readonly string[];
  readonly config?: RecipeUnitConfigMap;
}

/** Select every unit, with optional pattern-based exclusions. */
export interface AllSelector {
  readonly type: 'all';
  readonly exclude?: readonly string[];
  readonly config?: RecipeUnitConfigMap;
}

/** Select units whose tags intersect `include` and avoid `exclude`. */
export interface TagsSelector {
  readonly type: 'tags';
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
  readonly config?: RecipeUnitConfigMap;
}

/** Select units whose match keys glob-match `include` and avoid `exclude`. */
export interface PatternSelector {
  readonly type: 'pattern';
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
  readonly config?: RecipeUnitConfigMap;
}

/**
 * The generic selector union. Tools alias the `explicit` arm's `ids` to
 * their historical field name (fitness `checkIds`, sim `scenarioIds`) in
 * their own `types.ts` so existing recipe literals are unchanged, and may
 * extend the union with tool-only arms (sim `kind`).
 */
export type RecipeSelector = ExplicitSelector | AllSelector | TagsSelector | PatternSelector;

/**
 * Injected, tool-supplied resolution hooks. Keeping these external is what
 * lets core resolve selectors without naming any tool type.
 */
export interface ResolveSelectorOptions<T extends Registerable, S extends { readonly type: string }> {
  /** Match keys for an item — used by the `all` and `pattern` arms. */
  readonly keysOf: (item: T) => readonly string[];
  /** Tags an item carries — used by the built-in `tags` arm. Defaults to `item.tags ?? []`. */
  readonly tagsOf?: (item: T) => readonly string[];
  /** Glob matcher for `pattern` / `all` exclude matching. Required only if such an arm reaches the resolver. */
  readonly match?: (target: string, pattern: string) => boolean;
  /**
   * Fallback lookup for an `explicit` id that is not itself a primary key
   * — e.g. fitness's bare-slug → namespaced-key resolution. Returns the
   * canonical primary key, or `undefined`. When omitted, explicit ids are
   * matched as literal primary keys only.
   */
  readonly resolveExplicit?: (id: string, items: readonly T[]) => string | undefined;
  /**
   * Per-arm predicates for arms core cannot name (sim `kind`) or whose
   * semantics differ from the built-in arm (sim `tags`). Keyed by arm
   * `type`; when present for the active arm it overrides the built-in.
   */
  readonly predicates?: Readonly<Record<string, (item: T, selector: S) => boolean>>;
}

const NO_MATCHER_CODE = 'SYSTEM.CORE.SELECTOR_NO_MATCHER';
const UNKNOWN_SELECTOR_CODE = 'SYSTEM.CORE.UNKNOWN_SELECTOR';

function requireMatcher<T extends Registerable, S extends { readonly type: string }>(
  opts: ResolveSelectorOptions<T, S>,
  arm: string,
): (target: string, pattern: string) => boolean {
  if (opts.match === undefined) {
    // @fitness-ignore-next-line result-pattern-consistency -- programmer error: a pattern/all-exclude arm reached the resolver without an injected matcher
    throw new SystemError(`resolveSelector: '${arm}' selector needs a 'match' matcher but none was supplied`, {
      code: NO_MATCHER_CODE,
    });
  }
  return opts.match;
}

/**
 * Resolve a selector against a caller-supplied item list, returning the
 * selected items in the appropriate order. Pure — no logging, no I/O.
 *
 * A tool-supplied predicate for the active arm overrides the built-in
 * resolution, so a tool whose arm semantics differ (or whose arm core
 * cannot name) stays byte-exact without core knowing about it.
 */
export function resolveSelector<T extends Registerable, S extends { readonly type: string }>(
  selector: S,
  items: readonly T[],
  opts: ResolveSelectorOptions<T, S>,
): readonly T[] {
  // Tool-supplied predicates override any arm (built-in or tool-only).
  const predicate = opts.predicates?.[selector.type];
  if (predicate) return items.filter((item) => predicate(item, selector));

  const arm = selector as unknown as RecipeSelector;
  switch (arm.type) {
    case 'explicit': {
      // Mirror fitness `resolveExplicitSelector`: exact primary-key match,
      // else the injected fallback; preserve request order; no de-dup.
      const byId = new Map<string, T>();
      for (const item of items) byId.set(item.id, item);
      const result: T[] = [];
      for (const id of arm.ids) {
        let item = byId.get(id);
        if (item === undefined && opts.resolveExplicit !== undefined) {
          const key = opts.resolveExplicit(id, items);
          if (key !== undefined) item = byId.get(key);
        }
        if (item !== undefined) result.push(item);
      }
      return result;
    }
    case 'all': {
      const exclude = arm.exclude ?? [];
      if (exclude.length === 0) return items;
      const match = requireMatcher(opts, 'all');
      return items.filter((item) => {
        const targets = opts.keysOf(item);
        const excluded = exclude.some((pattern) => targets.some((target) => match(target, pattern)));
        return !excluded;
      });
    }
    case 'tags': {
      const include = new Set(arm.include);
      const exclude = new Set(arm.exclude ?? []);
      const tagsOf = opts.tagsOf ?? ((item: T) => item.tags ?? []);
      return items.filter((item) => {
        const tags = tagsOf(item);
        if (!tags.some((tag) => include.has(tag))) return false;
        if (tags.some((tag) => exclude.has(tag))) return false;
        return true;
      });
    }
    case 'pattern': {
      const match = requireMatcher(opts, 'pattern');
      const exclude = arm.exclude ?? [];
      return items.filter((item) => {
        const targets = opts.keysOf(item);
        const included = arm.include.some((pattern) => targets.some((target) => match(target, pattern)));
        if (!included) return false;
        const excluded = exclude.some((pattern) => targets.some((target) => match(target, pattern)));
        return !excluded;
      });
    }
    /* v8 ignore start -- exhaustive guard: a tool-only arm with no matching predicate lands here */
    default: {
      const _exhaustive: never = arm;
      // @fitness-ignore-next-line result-pattern-consistency -- programmer error: unknown selector arm with no predicate
      throw new SystemError(`resolveSelector: unknown selector type: ${JSON.stringify(_exhaustive)}`, {
        code: UNKNOWN_SELECTOR_CODE,
      });
    }
    /* v8 ignore stop */
  }
}
