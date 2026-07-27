import { createToolError, RunScope, runWithScopeSync } from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { graphErrorCatalog } from '../../errors/graph-error-catalog.js';
import { CatalogRepo } from '../../persistence/catalog-repo.js';
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

function testLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('context catalog RunScope accessor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('contains datastore resolution failures inside the Result boundary', () => {
    const logger = testLogger();
    const privateDetail = '/private/repo/opensip-cli/.runtime/datastore.sqlite';
    const scope = new RunScope({
      datastore: () => {
        throw new Error(`cannot open ${privateDetail}`);
      },
      logger,
    });

    runWithScopeSync(scope, () => {
      const result = createContextCatalogAccessor().load();
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'context-catalog-load-failed',
          operation: 'catalog-generation',
          message: 'Failed to load the graph context catalog.',
        },
      });
      expect(JSON.stringify(result)).not.toContain(privateDetail);
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'graph.context-catalog.operation-failed',
        module: 'graph:context-catalog-accessor',
        code: 'GRAPH.CONTEXT_CATALOG.OPERATION_FAILED',
        boundaryCode: 'GRAPH.CONTEXT_CATALOG.OPERATION_FAILED',
        condition: 'datastore-resolution',
        failure: expect.objectContaining({
          code: 'GRAPH.CONTEXT_CATALOG.OPERATION_FAILED',
        }) as object,
      }),
    );
  });

  it.each([
    {
      operation: 'load',
      method: 'loadFullCatalog',
      condition: 'catalog-load',
      reason: 'context-catalog-load-failed',
      message: 'Failed to load the graph context catalog.',
    },
    {
      operation: 'generationIdentity',
      method: 'readIdentity',
      condition: 'catalog-identity',
      reason: 'context-catalog-identity-failed',
      message: 'Failed to read the graph context catalog identity.',
    },
    {
      operation: 'replace',
      method: 'replaceAll',
      condition: 'catalog-replace',
      reason: 'context-catalog-replace-failed',
      message: 'Failed to replace the graph context catalog.',
    },
  ] as const)(
    'returns a bounded $reason Result and logs the $condition failure',
    ({ operation, method, condition, reason, message }) => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      const logger = testLogger();
      vi.spyOn(CatalogRepo.prototype, method).mockImplementation(() => {
        throw new Error('repository detail');
      });

      try {
        runWithScopeSync(new RunScope({ datastore: () => datastore, logger }), () => {
          const accessor = createContextCatalogAccessor();
          const result =
            operation === 'replace' ? accessor.replace(catalog) : accessor[operation]();
          expect(result).toEqual({
            ok: false,
            error: { code: reason, operation: 'catalog-generation', message },
          });
        });
      } finally {
        datastore.close();
      }

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'graph.context-catalog.operation-failed',
          code: 'GRAPH.CONTEXT_CATALOG.OPERATION_FAILED',
          boundaryCode: 'GRAPH.CONTEXT_CATALOG.OPERATION_FAILED',
          condition,
        }),
      );
    },
  );

  it('preserves an existing definition-backed failure in operator evidence', () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const logger = testLogger();
    const existing = graphErrorCatalog.require('GRAPH.CATALOG.UNREADABLE');
    vi.spyOn(CatalogRepo.prototype, 'loadFullCatalog').mockImplementation(() => {
      throw createToolError(existing, 'Catalog integrity failed.');
    });

    try {
      runWithScopeSync(new RunScope({ datastore: () => datastore, logger }), () => {
        expect(createContextCatalogAccessor().load()).toMatchObject({
          ok: false,
          error: { code: 'context-catalog-load-failed' },
        });
      });
    } finally {
      datastore.close();
    }

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'GRAPH.CATALOG.UNREADABLE',
        boundaryCode: 'GRAPH.CONTEXT_CATALOG.OPERATION_FAILED',
        failure: expect.objectContaining({ code: 'GRAPH.CATALOG.UNREADABLE' }) as object,
      }),
    );
  });
});
