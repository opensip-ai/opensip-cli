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

import type { RecipeUnitConfigMap } from './unit-config.js';
import type { Registerable } from '../lib/registry.js';

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

/** Glob matcher injected by the tool for the `pattern` / `all` arms. */
type Matcher = (target: string, pattern: string) => boolean;

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
  readonly match?: Matcher;
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

function requireMatcher(match: Matcher | undefined, arm: string): Matcher {
  if (match === undefined) {
    // @fitness-ignore-next-line result-pattern-consistency -- programmer error: a pattern/all-exclude arm reached the resolver without an injected matcher
    throw new SystemError(`resolveSelector: '${arm}' selector needs a 'match' matcher but none was supplied`, {
      code: NO_MATCHER_CODE,
    });
  }
  return match;
}

/** `explicit`: exact primary-key match then injected fallback; request order; no de-dup. */
function resolveExplicitArm<T extends Registerable>(
  ids: readonly string[],
  items: readonly T[],
  resolveExplicit: ((id: string, items: readonly T[]) => string | undefined) | undefined,
): readonly T[] {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  const result: T[] = [];
  for (const id of ids) {
    let item = byId.get(id);
    if (item === undefined && resolveExplicit !== undefined) {
      const key = resolveExplicit(id, items);
      if (key !== undefined) item = byId.get(key);
    }
    if (item !== undefined) result.push(item);
  }
  return result;
}

/** `all`: every item, minus any whose match keys glob-match an exclude pattern. */
function resolveAllArm<T extends Registerable>(
  exclude: readonly string[],
  items: readonly T[],
  keysOf: (item: T) => readonly string[],
  match: Matcher | undefined,
): readonly T[] {
  if (exclude.length === 0) return items;
  const matcher = requireMatcher(match, 'all');
  return items.filter((item) => {
    const targets = keysOf(item);
    return !exclude.some((pattern) => targets.some((target) => matcher(target, pattern)));
  });
}

/** `tags`: items whose tags intersect `include` and avoid `exclude` (tag-based). */
function resolveTagsArm<T extends Registerable>(
  include: readonly string[],
  exclude: readonly string[],
  items: readonly T[],
  tagsOf: (item: T) => readonly string[],
): readonly T[] {
  const includeSet = new Set(include);
  const excludeSet = new Set(exclude);
  return items.filter((item) => {
    const tags = tagsOf(item);
    return tags.some((tag) => includeSet.has(tag)) && !tags.some((tag) => excludeSet.has(tag));
  });
}

/** `pattern`: items whose match keys glob-match some `include` and no `exclude`. */
function resolvePatternArm<T extends Registerable>(
  include: readonly string[],
  exclude: readonly string[],
  items: readonly T[],
  keysOf: (item: T) => readonly string[],
  match: Matcher | undefined,
): readonly T[] {
  const matcher = requireMatcher(match, 'pattern');
  return items.filter((item) => {
    const targets = keysOf(item);
    const included = include.some((pattern) => targets.some((target) => matcher(target, pattern)));
    if (!included) return false;
    return !exclude.some((pattern) => targets.some((target) => matcher(target, pattern)));
  });
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
      return resolveExplicitArm(arm.ids, items, opts.resolveExplicit);
    }
    case 'all': {
      return resolveAllArm(arm.exclude ?? [], items, opts.keysOf, opts.match);
    }
    case 'tags': {
      return resolveTagsArm(arm.include, arm.exclude ?? [], items, opts.tagsOf ?? ((item) => item.tags ?? []));
    }
    case 'pattern': {
      return resolvePatternArm(arm.include, arm.exclude ?? [], items, opts.keysOf, opts.match);
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
