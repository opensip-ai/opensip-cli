import { NotFoundError } from '@opensip-tools/core';
import { describe, it, expect } from 'vitest';

import { CheckRegistry } from '../../framework/registry.js';

import type { Check } from '../../framework/check-types.js';

/** Create a minimal Check stub for testing the registry. */
function makeCheck(overrides: {
  slug: string;
  tags?: string[];
  disabled?: boolean;
  id?: string;
}): Check {
  return {
    config: {
      id: overrides.id ?? `id-${overrides.slug}`,
      slug: overrides.slug,
      tags: overrides.tags ?? ['quality'],
      description: `Check: ${overrides.slug}`,
      analysisMode: 'analyze',
      scope: { include: [], exclude: [] },
      itemType: 'file' as unknown as Check['config']['itemType'],
      disabled: overrides.disabled,
      // eslint-disable-next-line @typescript-eslint/require-await -- mock matches expected `() => Promise<CheckResult>` shape
      execute: async () => ({ findings: [], passed: true }),
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- mock matches expected `() => Promise<CheckResult>` shape
    run: async () => ({ findings: [], passed: true }),
    getScope: () => ({ include: [], exclude: [] }),
    getMatcher: () => ({ matches: () => true }),
  } as unknown as Check;
}

describe('CheckRegistry', () => {
  describe('register and get', () => {
    it('registers and retrieves a check by slug', () => {
      const registry = new CheckRegistry();
      const check = makeCheck({ slug: 'my-check' });
      registry.register(check);
      expect(registry.get('my-check')).toBe(check);
    });

    it('throws NotFoundError for missing slug', () => {
      const registry = new CheckRegistry();
      expect(() => registry.get('nonexistent')).toThrow(NotFoundError);
      expect(() => registry.get('nonexistent')).toThrow('Check not found: nonexistent');
    });
  });

  describe('has', () => {
    it('returns true for registered check', () => {
      const registry = new CheckRegistry();
      registry.register(makeCheck({ slug: 'exists' }));
      expect(registry.has('exists')).toBe(true);
    });

    it('returns false for unregistered check', () => {
      const registry = new CheckRegistry();
      expect(registry.has('nope')).toBe(false);
    });
  });

  describe('duplicate handling', () => {
    it('silently skips duplicate registration', () => {
      const registry = new CheckRegistry();
      const check1 = makeCheck({ slug: 'dup', id: 'first' });
      const check2 = makeCheck({ slug: 'dup', id: 'second' });
      registry.register(check1);
      registry.register(check2);
      // First registration wins
      expect(registry.get('dup').config.id).toBe('first');
      expect(registry.size).toBe(1);
    });
  });

  describe('list', () => {
    it('returns all registered checks', () => {
      const registry = new CheckRegistry();
      registry.register(makeCheck({ slug: 'a' }));
      registry.register(makeCheck({ slug: 'b' }));
      registry.register(makeCheck({ slug: 'c' }));
      expect(registry.list()).toHaveLength(3);
    });

    it('returns empty array when no checks registered', () => {
      const registry = new CheckRegistry();
      expect(registry.list()).toEqual([]);
    });
  });

  describe('listEnabled', () => {
    it('excludes disabled checks', () => {
      const registry = new CheckRegistry();
      registry.register(makeCheck({ slug: 'active' }));
      registry.register(makeCheck({ slug: 'off', disabled: true }));
      registry.register(makeCheck({ slug: 'also-active' }));

      const enabled = registry.listEnabled();
      expect(enabled).toHaveLength(2);
      expect(enabled.map((c) => c.config.slug)).toEqual(['active', 'also-active']);
    });

    it('returns all checks when none are disabled', () => {
      const registry = new CheckRegistry();
      registry.register(makeCheck({ slug: 'x' }));
      registry.register(makeCheck({ slug: 'y' }));
      expect(registry.listEnabled()).toHaveLength(2);
    });
  });

  describe('byTag', () => {
    it('filters enabled checks by tag', () => {
      const registry = new CheckRegistry();
      registry.register(makeCheck({ slug: 'sec1', tags: ['security'] }));
      registry.register(makeCheck({ slug: 'qual1', tags: ['quality'] }));
      registry.register(makeCheck({ slug: 'sec2', tags: ['security'] }));
      registry.register(makeCheck({ slug: 'sec-off', tags: ['security'], disabled: true }));

      const securityChecks = registry.byTag('security');
      expect(securityChecks).toHaveLength(2);
      expect(securityChecks.map((c) => c.config.slug)).toEqual(['sec1', 'sec2']);
    });

    it('returns empty array for unknown tag', () => {
      const registry = new CheckRegistry();
      registry.register(makeCheck({ slug: 'a', tags: ['quality'] }));
      expect(registry.byTag('nonexistent')).toEqual([]);
    });
  });

  describe('getBySlug', () => {
    it('returns the check when found', () => {
      const registry = new CheckRegistry();
      const check = makeCheck({ slug: 'findme' });
      registry.register(check);
      expect(registry.getBySlug('findme')).toBe(check);
    });

    it('returns undefined when not found (no throw)', () => {
      const registry = new CheckRegistry();
      expect(registry.getBySlug('missing')).toBeUndefined();
    });
  });

  describe('listSlugs', () => {
    it('returns all registered slugs', () => {
      const registry = new CheckRegistry();
      registry.register(makeCheck({ slug: 'alpha' }));
      registry.register(makeCheck({ slug: 'beta' }));
      registry.register(makeCheck({ slug: 'gamma' }));

      const slugs = registry.listSlugs();
      expect(slugs).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('returns empty array when empty', () => {
      const registry = new CheckRegistry();
      expect(registry.listSlugs()).toEqual([]);
    });
  });

  describe('size', () => {
    it('reflects current count', () => {
      const registry = new CheckRegistry();
      expect(registry.size).toBe(0);
      registry.register(makeCheck({ slug: 'one' }));
      expect(registry.size).toBe(1);
      registry.register(makeCheck({ slug: 'two' }));
      expect(registry.size).toBe(2);
    });
  });

  describe('namespace support', () => {
    it('registers with namespace as namespace:slug key', () => {
      const registry = new CheckRegistry();
      const check = makeCheck({ slug: 'my-check' });
      registry.register(check, 'my-plugin');
      expect(registry.get('my-plugin:my-check')).toBe(check);
    });

    it('resolves bare slug to namespaced check when unambiguous', () => {
      const registry = new CheckRegistry();
      const check = makeCheck({ slug: 'my-check' });
      registry.register(check, 'my-plugin');
      expect(registry.get('my-check')).toBe(check);
      expect(registry.getBySlug('my-check')).toBe(check);
      expect(registry.has('my-check')).toBe(true);
    });

    it('allows same slug in different namespaces', () => {
      const registry = new CheckRegistry();
      const check1 = makeCheck({ slug: 'check', id: 'first' });
      const check2 = makeCheck({ slug: 'check', id: 'second' });
      registry.register(check1, 'plugin-a');
      registry.register(check2, 'plugin-b');
      expect(registry.size).toBe(2);
      expect(registry.get('plugin-a:check').config.id).toBe('first');
      expect(registry.get('plugin-b:check').config.id).toBe('second');
    });

    it('returns first registered for ambiguous bare slug', () => {
      const registry = new CheckRegistry();
      registry.register(makeCheck({ slug: 'dup', id: 'first' }), 'ns-a');
      registry.register(makeCheck({ slug: 'dup', id: 'second' }), 'ns-b');
      // Resolves to first registered
      expect(registry.get('dup').config.id).toBe('first');
    });

    it('silently skips duplicate namespace:slug registration', () => {
      const registry = new CheckRegistry();
      const check1 = makeCheck({ slug: 'x', id: 'first' });
      const check2 = makeCheck({ slug: 'x', id: 'second' });
      registry.register(check1, 'ns');
      registry.register(check2, 'ns');
      expect(registry.size).toBe(1);
      expect(registry.get('ns:x').config.id).toBe('first');
    });

    it('listSlugs returns namespaced keys', () => {
      const registry = new CheckRegistry();
      registry.register(makeCheck({ slug: 'a' }), 'pkg');
      registry.register(makeCheck({ slug: 'b' }));
      expect(registry.listSlugs()).toEqual(['pkg:a', 'b']);
    });

    it('listByBareSlug returns all checks with that slug', () => {
      const registry = new CheckRegistry();
      registry.register(makeCheck({ slug: 'check', id: '1' }), 'ns-a');
      registry.register(makeCheck({ slug: 'check', id: '2' }), 'ns-b');
      registry.register(makeCheck({ slug: 'other' }), 'ns-a');
      const results = registry.listByBareSlug('check');
      expect(results).toHaveLength(2);
      expect(results.map((c) => c.config.id)).toEqual(['1', '2']);
    });

    it('returns undefined for unknown namespaced slug', () => {
      const registry = new CheckRegistry();
      registry.register(makeCheck({ slug: 'a' }), 'pkg');
      expect(registry.getBySlug('other:a')).toBeUndefined();
    });
  });
});
