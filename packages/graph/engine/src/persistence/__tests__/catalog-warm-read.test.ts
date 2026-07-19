/**
 * @fileoverview Trusted warm-read gate (plan 09 Task 6.1). A warm re-read
 * whose lifted identity columns are consistent with the payload skips the
 * exhaustive O(occurrences) container walk; the cheap shape/version gate
 * ALWAYS runs, so a genuinely corrupt row still fails loud on the fast path,
 * and an identity-inconsistent row falls back to the full walk.
 */

import { logger } from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CatalogRepo } from '../catalog-repo.js';
import { graphCatalog } from '../schema.js';

import type { Catalog } from '../../types.js';

function catalog(): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-18T00:00:00.000Z',
    cacheKey: 'cache-key-1',
    functions: {
      alpha: [
        {
          bodyHash: 'h1',
          kind: 'function-declaration',
          inTestFile: false,
          filePath: 'src/a.ts',
          line: 1,
          column: 0,
          endLine: 3,
          simpleName: 'alpha',
          qualifiedName: 'a.alpha',
          calls: [],
        },
      ],
    },
  } as unknown as Catalog;
}

function revalidateModes(debug: ReturnType<typeof vi.spyOn>): string[] {
  return debug.mock.calls
    .map(([entry]: readonly unknown[]) => entry as { evt?: string; mode?: string })
    .filter(
      (entry: { evt?: string; mode?: string }) => entry.evt === 'graph.catalog.warmread.revalidate',
    )
    .map((entry: { evt?: string; mode?: string }) => entry.mode ?? '');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CatalogRepo — trusted warm read', () => {
  it('walks on the FIRST load of an identity, then skips on the warm re-read', () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    try {
      const repo = new CatalogRepo(store);
      repo.replaceAll(catalog());
      const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

      const first = repo.loadFullCatalog();
      const second = repo.loadFullCatalog();
      // A fresh repo instance over the SAME store shares the validation fact.
      const third = new CatalogRepo(store).loadFullCatalog();

      expect(first?.cacheKey).toBe('cache-key-1');
      expect(second?.cacheKey).toBe('cache-key-1');
      expect(third?.cacheKey).toBe('cache-key-1');
      expect(revalidateModes(debug)).toEqual(['full', 'skipped', 'skipped']);
    } finally {
      store.close();
    }
  });

  it('falls back to the full walk when a lifted column disagrees with the payload', () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    try {
      const repo = new CatalogRepo(store);
      repo.replaceAll(catalog());
      // Validate once (memoizes the ORIGINAL identity), then drift a lifted
      // column: the changed identity must NOT ride the memoized trust.
      repo.loadFullCatalog();
      requireDrizzleHandle(store)
        .db.update(graphCatalog)
        .set({ cacheKey: 'drifted-key' })
        .where(sql`id = 1`)
        .run();
      const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

      const loaded = repo.loadFullCatalog();

      expect(loaded?.cacheKey).toBe('cache-key-1');
      expect(revalidateModes(debug)).toEqual(['full']);
    } finally {
      store.close();
    }
  });

  it('still fails loud on a corrupt payload even on the warm path (cheap gate)', () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    try {
      const repo = new CatalogRepo(store);
      repo.replaceAll(catalog());
      // Corrupt the envelope itself — the always-on shape gate must throw
      // regardless of any trust decision.
      requireDrizzleHandle(store)
        .db.update(graphCatalog)
        .set({ payload: { version: 'evil', tool: 'graph' } })
        .where(sql`id = 1`)
        .run();
      vi.spyOn(logger, 'error').mockImplementation(() => undefined);

      expect(() => repo.loadFullCatalog()).toThrow('Malformed catalog payload');
    } finally {
      store.close();
    }
  });

  it('fails loud on malformed function containers when identity is inconsistent', () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    try {
      const repo = new CatalogRepo(store);
      const bad = catalog();
      repo.replaceAll(bad);
      // Malformed container + drifted lifted identity → the untrusted path
      // runs the exhaustive walk and rejects.
      const payload = {
        version: '3.0',
        tool: 'graph',
        language: 'typescript',
        builtAt: '2026-07-18T00:00:00.000Z',
        cacheKey: 'cache-key-1',
        functions: { alpha: 'not-an-array' },
      };
      requireDrizzleHandle(store)
        .db.update(graphCatalog)
        .set({ payload, cacheKey: 'drifted' })
        .where(sql`id = 1`)
        .run();
      vi.spyOn(logger, 'error').mockImplementation(() => undefined);

      expect(() => repo.loadFullCatalog()).toThrow('Malformed catalog function container');
    } finally {
      store.close();
    }
  });
});
