import { describe, expect, it } from 'vitest';

import { CheckRegistry } from '../registry.js';

import type { Check } from '../check-types.js';

function makeCheck(opts: { slug: string; id?: string }): Check {
  const slug = opts.slug;
  return {
    config: {
      id: opts.id ?? `id-${slug}`,
      slug,
      tags: ['quality'],
      description: `Check: ${slug}`,
      analysisMode: 'analyze',
      scope: { include: [], exclude: [], description: '' },
      itemType: 'files',
      // eslint-disable-next-line @typescript-eslint/require-await -- mock
      execute: async () => ({ findings: [], passed: true }),
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    run: async () => ({ findings: [], passed: true }),
    getScope: () => ({ include: [], exclude: [], description: '' }),
    getMatcher: () => ({ matches: () => true }),
  } as unknown as Check;
}

describe('CheckRegistry.resolveBareSlug', () => {
  it('returns the exact key for a namespaced slug', () => {
    const registry = new CheckRegistry();
    registry.register(makeCheck({ slug: 'no-eval' }), 'pack-a');
    expect(registry.resolveBareSlug('pack-a:no-eval')).toBe('pack-a:no-eval');
  });

  it('resolves an unambiguous bare slug to its namespaced key', () => {
    const registry = new CheckRegistry();
    registry.register(makeCheck({ slug: 'no-eval' }), 'pack-a');
    expect(registry.resolveBareSlug('no-eval')).toBe('pack-a:no-eval');
  });

  it('returns undefined for an ambiguous bare slug (fail-closed)', () => {
    const registry = new CheckRegistry();
    registry.register(makeCheck({ slug: 'no-eval', id: 'first' }), 'pack-a');
    registry.register(makeCheck({ slug: 'no-eval', id: 'second' }), 'pack-b');
    expect(registry.resolveBareSlug('no-eval')).toBeUndefined();
  });

  it('returns undefined for unknown slugs', () => {
    const registry = new CheckRegistry();
    expect(registry.resolveBareSlug('missing')).toBeUndefined();
    expect(registry.resolveBareSlug('pack-a:missing')).toBeUndefined();
  });

  it('returns a bare-registered key unchanged', () => {
    const registry = new CheckRegistry();
    registry.register(makeCheck({ slug: 'bare-only' }));
    expect(registry.resolveBareSlug('bare-only')).toBe('bare-only');
  });
});
