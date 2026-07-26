import { RunScope, runWithScopeSync } from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { describe, expect, it } from 'vitest';

import { createContextCatalogAccessor } from '../../persistence/context-catalog-accessor.js';
import { catalogGenerationKey } from '../../read/catalog-generation-key.js';

import type { Catalog } from '../../types.js';

const catalog: Catalog = {
  version: '3.0',
  tool: 'graph',
  language: 'typescript',
  builtAt: '2026-07-13T00:00:00.000Z',
  cacheKey: 'cache',
  filesFingerprint: 'fingerprint',
  functions: {},
};

describe('context catalog RunScope accessor', () => {
  it('owns lazy datastore resolution and canonical replacement', () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const scope = new RunScope({ datastore: () => datastore });
      runWithScopeSync(scope, () => {
        const accessor = createContextCatalogAccessor();
        expect(accessor.load()).toEqual({ ok: true, value: null });
        expect(accessor.generationIdentity()).toEqual({ ok: true, value: null });
        expect(accessor.replace(catalog)).toEqual({ ok: true, value: undefined });
        expect(accessor.generationIdentity()).toEqual({
          ok: true,
          value: catalogGenerationKey({
            language: catalog.language,
            cacheKey: catalog.cacheKey,
            filesFingerprint: catalog.filesFingerprint ?? '',
            builtAt: catalog.builtAt,
          }),
        });
        expect(accessor.load()).toMatchObject({
          ok: true,
          value: {
            cacheKey: 'cache',
            filesFingerprint: 'fingerprint',
          },
        });
      });
    } finally {
      datastore.close();
    }
  });

  it('returns a bounded error when no project datastore is entered', () => {
    runWithScopeSync(new RunScope(), () => {
      const accessor = createContextCatalogAccessor();
      const expected = {
        ok: false,
        error: {
          code: 'context-catalog-datastore-required',
          operation: 'catalog-generation',
          message: 'Graph context requires an entered project datastore.',
        },
      };
      expect(accessor.load()).toEqual(expected);
      expect(accessor.generationIdentity()).toEqual(expected);
    });
  });
});
