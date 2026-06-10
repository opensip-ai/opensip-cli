/**
 * @fileoverview Characterization + unit tests for the generic recipe
 * resolver (`resolveSelector`).
 *
 * The resolver is the selection algorithm fitness (`resolveChecks`) and
 * simulation (in-service resolver) now delegate to. These tests lock its
 * output for each arm, the predicate-override path, and the two
 * programmer-error guards — independent of any tool (core cannot import
 * fitness/sim). The real no-behavior-change proof for the tools lives in
 * their own suites, which pass unedited; this pins the substrate itself.
 *
 * Expected outputs are asserted with explicit `toEqual` (not auto-filled
 * snapshots) so the locked values are hand-reviewed in the diff.
 *
 * `minimatch` is not a core dependency, so the `pattern`/`all` glob matcher
 * is a tiny test-only `*`-glob — sufficient for these fixtures; fitness
 * injects the real `minimatch` in production.
 */

import { describe, expect, it } from 'vitest';

import { SystemError } from '../../lib/errors.js';
import { resolveSelector, type RecipeSelector, type ResolveSelectorOptions } from '../selector.js';

import type { Registerable } from '../../lib/registry.js';

/** Test-only `*`-glob matcher (exact match when the pattern has no `*`). */
function glob(target: string, pattern: string): boolean {
  if (!pattern.includes('*')) return target === pattern;
  const escaped = pattern
    .split('*')
    .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`));
  return new RegExp(`^${escaped.join('.*')}$`).test(target);
}

interface Item extends Registerable {
  readonly kind?: string;
}

/** A `kind` arm, mirroring simulation's tool-only selector. */
interface KindSelector {
  readonly type: 'kind';
  readonly kinds: readonly string[];
  readonly exclude?: readonly string[];
}

type AnySelector = RecipeSelector | KindSelector;

const items: readonly Item[] = [
  { id: 'security:no-eval', name: 'security:no-eval', tags: ['security', 'architecture'] },
  { id: 'security:no-exec', name: 'security:no-exec', tags: ['security'] },
  { id: 'backend:no-sync-fs', name: 'backend:no-sync-fs', tags: ['backend'] },
  { id: 'frontend:no-inline-style', name: 'frontend:no-inline-style', tags: ['frontend'] },
  { id: 'architecture:layering', name: 'architecture:layering', tags: ['architecture'] },
  { id: 'no-todo', name: 'no-todo', tags: [] },
  { id: 'backend:max-params', name: 'backend:max-params', tags: ['backend', 'architecture'] },
  { id: 'load-test', name: 'load-test', tags: ['load'], kind: 'load' },
];

/** Fitness-style match targets: key + bare slug + `tag/bareSlug`. */
function buildMatchTargets(slug: string, tags: readonly string[] = []): string[] {
  const targets = [slug];
  const bare = slug.includes(':') ? slug.split(':').pop()! : slug;
  if (bare !== slug) targets.push(bare);
  for (const tag of tags) targets.push(`${tag}/${bare}`);
  return targets;
}

/** Fitness-shaped options: glob match + bare-slug → namespaced-key reverse lookup. */
const fitnessOpts: ResolveSelectorOptions<Item, AnySelector> = {
  keysOf: (item) => buildMatchTargets(item.id, item.tags),
  tagsOf: (item) => item.tags ?? [],
  match: glob,
  resolveExplicit: (id) => {
    if (id.includes(':')) return undefined;
    const found = items.find((item) => item.id.endsWith(`:${id}`));
    return found?.id;
  },
};

const ids = (result: readonly Item[]): readonly string[] => result.map((item) => item.id);

describe('resolveSelector — built-in arms', () => {
  it('explicit: exact key, bare-slug reverse lookup, request order, no de-dup', () => {
    const result = resolveSelector<Item, AnySelector>(
      { type: 'explicit', ids: ['security:no-eval', 'no-todo', 'no-exec'] },
      items,
      fitnessOpts,
    );
    expect(ids(result)).toEqual(['security:no-eval', 'no-todo', 'security:no-exec']);
  });

  it('all: no exclude returns every item in registration order', () => {
    const result = resolveSelector<Item, AnySelector>({ type: 'all' }, items, fitnessOpts);
    expect(ids(result)).toEqual([
      'security:no-eval',
      'security:no-exec',
      'backend:no-sync-fs',
      'frontend:no-inline-style',
      'architecture:layering',
      'no-todo',
      'backend:max-params',
      'load-test',
    ]);
  });

  it('all: glob exclude drops matched keys', () => {
    const result = resolveSelector<Item, AnySelector>(
      { type: 'all', exclude: ['security:*'] },
      items,
      fitnessOpts,
    );
    expect(ids(result)).toEqual([
      'backend:no-sync-fs',
      'frontend:no-inline-style',
      'architecture:layering',
      'no-todo',
      'backend:max-params',
      'load-test',
    ]);
  });

  it('tags: include intersection (exclude is over tags)', () => {
    const result = resolveSelector<Item, AnySelector>(
      { type: 'tags', include: ['architecture'] },
      items,
      fitnessOpts,
    );
    expect(ids(result)).toEqual([
      'security:no-eval',
      'architecture:layering',
      'backend:max-params',
    ]);
  });

  it('tags: tag-based exclude removes matched items', () => {
    const result = resolveSelector<Item, AnySelector>(
      { type: 'tags', include: ['architecture'], exclude: ['security'] },
      items,
      fitnessOpts,
    );
    // security:no-eval carries the 'security' tag → excluded.
    expect(ids(result)).toEqual(['architecture:layering', 'backend:max-params']);
  });

  it('pattern: include globs over match targets, minus exclude globs', () => {
    const result = resolveSelector<Item, AnySelector>(
      { type: 'pattern', include: ['backend:*'] },
      items,
      fitnessOpts,
    );
    expect(ids(result)).toEqual(['backend:no-sync-fs', 'backend:max-params']);
  });
});

describe('resolveSelector — guards', () => {
  it('throws SELECTOR_NO_MATCHER when an exclude arm has no injected matcher', () => {
    const noMatch: ResolveSelectorOptions<Item, AnySelector> = {
      keysOf: (item) => [item.id],
    };
    try {
      resolveSelector<Item, AnySelector>({ type: 'all', exclude: ['x'] }, items, noMatch);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SystemError);
      expect((error as SystemError).code).toBe('SYSTEM.CORE.SELECTOR_NO_MATCHER');
    }
  });

  it('throws UNKNOWN_SELECTOR for a tool-only arm with no predicate', () => {
    try {
      resolveSelector<Item, AnySelector>({ type: 'kind', kinds: ['load'] }, items, fitnessOpts);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SystemError);
      expect((error as SystemError).code).toBe('SYSTEM.CORE.UNKNOWN_SELECTOR');
    }
  });
});

describe('resolveSelector — predicate override (simulation-style)', () => {
  const simOpts: ResolveSelectorOptions<Item, AnySelector> = {
    keysOf: (item) => [item.id, item.name],
    tagsOf: (item) => item.tags ?? [],
    predicates: {
      kind: (item, sel) => {
        if (sel.type !== 'kind') return false;
        const kinds = new Set(sel.kinds);
        const exclude = new Set(sel.exclude);
        return (
          item.kind !== undefined &&
          kinds.has(item.kind) &&
          !exclude.has(item.id) &&
          !exclude.has(item.name)
        );
      },
      // sim's `tags` excludes on id/name (not tags) — overrides the built-in arm.
      tags: (item, sel) => {
        if (sel.type !== 'tags') return false;
        const include = new Set(sel.include);
        const exclude = new Set(sel.exclude);
        return (
          (item.tags ?? []).some((t) => include.has(t)) &&
          !exclude.has(item.id) &&
          !exclude.has(item.name)
        );
      },
    },
  };

  it('kind predicate filters by item.kind', () => {
    const result = resolveSelector<Item, AnySelector>(
      { type: 'kind', kinds: ['load'] },
      items,
      simOpts,
    );
    expect(ids(result)).toEqual(['load-test']);
  });

  it('tags predicate excludes on id/name, not tags', () => {
    const result = resolveSelector<Item, AnySelector>(
      { type: 'tags', include: ['architecture'], exclude: ['security:no-eval'] },
      items,
      simOpts,
    );
    // 'security:no-eval' is excluded by id even though it carries 'architecture'.
    expect(ids(result)).toEqual(['architecture:layering', 'backend:max-params']);
  });
});
