import { join } from 'node:path';

import { ok } from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { CatalogRepo } from '@opensip-cli/graph/internal';
import { describe, expect, it } from 'vitest';

import { SqliteGraphReadPort } from '../sqlite-graph-read-port.js';

import type { GraphAdapterRegistryReader } from '@opensip-cli/graph/read';

const EMPTY_ADAPTERS: GraphAdapterRegistryReader = {
  size: 0,
  getAll: () => [],
  getById: () => undefined,
};

describe('graph evidence context path privacy', () => {
  it('keeps project.root explicit while projecting configPath relative to it', async () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    const root = '/workspace/project';
    const port = new SqliteGraphReadPort({
      store,
      projectRoot: root,
      configPath: join(root, 'config', 'opensip.yml'),
      adapters: EMPTY_ADAPTERS,
      languageAdapters: [],
      rebuild: () =>
        Promise.resolve(
          ok({
            version: '3.0',
            tool: 'graph',
            language: 'typescript',
            builtAt: '2026-07-10T00:00:00.000Z',
            cacheKey: 'cache',
            functions: {},
          }),
        ),
    });

    try {
      const status = await port.catalogStatus();
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.value.context.project).toEqual({
        root,
        scope: 'project',
        configPath: 'config/opensip.yml',
      });
      expect(status.value.context.project.configPath).not.toContain(root);
    } finally {
      store.close();
    }
  });

  it('uses a bounded sentinel for a config path outside the project', async () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    const port = new SqliteGraphReadPort({
      store,
      projectRoot: '/workspace/project',
      configPath: '/private/outside.yml',
      adapters: EMPTY_ADAPTERS,
      languageAdapters: [],
      rebuild: () =>
        Promise.resolve(
          ok({
            version: '3.0',
            tool: 'graph',
            language: 'typescript',
            builtAt: '2026-07-10T00:00:00.000Z',
            cacheKey: 'cache',
            functions: {},
          }),
        ),
    });

    try {
      const status = await port.catalogStatus();
      expect(status.ok && status.value.context.project.configPath).toBe('<outside-project>');
    } finally {
      store.close();
    }
  });

  it('preserves verifier errors for ordinary graph reads', async () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(store).replaceAll({
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: '2026-07-10T00:00:00.000Z',
      cacheKey: 'cache',
      filesFingerprint: '0',
      adapterSelection: {
        mode: 'forced',
        requestedId: 'typescript',
        selectedId: 'typescript',
      },
      engineMode: 'exact',
      functions: {},
    });
    const port = new SqliteGraphReadPort({
      store,
      projectRoot: '/workspace/project',
      adapters: EMPTY_ADAPTERS,
      languageAdapters: [],
      rebuild: () =>
        Promise.resolve(
          ok({
            version: '3.0',
            tool: 'graph',
            language: 'typescript',
            builtAt: '2026-07-10T00:00:00.000Z',
            cacheKey: 'cache',
            functions: {},
          }),
        ),
    });

    try {
      const status = await port.catalogStatus();
      const query = await port.resolveSymbolId('src/a.ts:1:0');
      expect(status.ok).toBe(false);
      expect(query.ok).toBe(false);
      if (!query.ok) expect(query.error.code).toBe('graph-read-failed');
    } finally {
      store.close();
    }
  });

  it('logs bounded operation-specific identity and source metadata only', async () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const port = new SqliteGraphReadPort({
      store,
      projectRoot: '/workspace/private-project',
      adapters: EMPTY_ADAPTERS,
      languageAdapters: [],
      rebuild: () =>
        Promise.resolve(
          ok({
            version: '3.0',
            tool: 'graph',
            language: 'typescript',
            builtAt: '2026-07-10T00:00:00.000Z',
            cacheKey: 'cache',
            functions: {},
          }),
        ),
      log: (event, fields) => events.push({ event, fields }),
    });

    try {
      await port.resolveSymbolId('private/file.ts:1:0');
      await port.traverse({
        direction: 'callers',
        startSymbolId: 'private/file.ts:1:0',
        identity: 'occurrence',
        filter: { sourceScope: 'production', generated: 'exclude' },
      });
      await port.blast('private/file.ts:1:0', {
        filter: { sourceScope: 'test', generated: 'exclude' },
      });
      const completed = events.filter((entry) => entry.event === 'mcp.graph.query.completed');
      expect(completed.map((entry) => entry.fields)).toEqual([
        expect.objectContaining({
          operation: 'resolveSymbolId',
          identityMode: 'occurrence',
          sourceScope: 'all',
        }),
        expect.objectContaining({
          operation: 'traverse',
          identityMode: 'occurrence',
          sourceScope: 'production',
        }),
        expect.objectContaining({
          operation: 'blast',
          identityMode: 'body-twin-union',
          sourceScope: 'test',
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain('private/file.ts');
      expect(JSON.stringify(events)).not.toContain('/workspace/private-project');
    } finally {
      store.close();
    }
  });

  it('emits the complete bounded query-failure event when a public read builder rejects input', async () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    const root = '/workspace/private-project';
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    new CatalogRepo(store).replaceAll({
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: '2026-07-10T00:00:00.000Z',
      cacheKey: 'cache',
      functions: {
        target: [
          {
            bodyHash: 'target-body',
            simpleName: 'private-query',
            qualifiedName: 'private-query',
            filePath: 'private/file.ts',
            line: 1,
            column: 0,
            endLine: 2,
            kind: 'function-declaration',
            params: [],
            returnType: null,
            enclosingClass: null,
            decorators: [],
            visibility: 'module-local',
            inTestFile: false,
            definedInGenerated: false,
            calls: [],
            package: 'private-package',
          },
        ],
      },
    });
    const port = new SqliteGraphReadPort({
      store,
      projectRoot: root,
      adapters: EMPTY_ADAPTERS,
      languageAdapters: [],
      rebuild: () =>
        Promise.resolve(
          ok({
            version: '3.0',
            tool: 'graph',
            language: 'typescript',
            builtAt: '2026-07-10T00:00:00.000Z',
            cacheKey: 'cache',
            functions: {},
          }),
        ),
      log: (event, fields) => events.push({ event, fields }),
    });

    try {
      const hostileOptions = {
        filter: { kinds: { length: 1 } },
      } as unknown as Parameters<SqliteGraphReadPort['searchSymbols']>[1];
      const result = await port.searchSymbols('private-query', hostileOptions);

      expect(result.ok).toBe(false);
      const failed = events.filter((entry) => entry.event === 'mcp.graph.query.failed');
      expect(failed).toEqual([
        {
          event: 'mcp.graph.query.failed',
          fields: {
            operation: 'searchSymbols',
            identityMode: 'occurrence',
            sourceScope: 'all',
            resultCount: 0,
            coverageComplete: false,
            coverageTruncated: false,
            outcome: 'failed',
            durationMs: expect.any(Number),
          },
        },
      ]);
      const logged = JSON.stringify(events);
      expect(logged).not.toContain('private-query');
      expect(logged).not.toContain('private/file.ts');
      expect(logged).not.toContain('private-package');
      expect(logged).not.toContain(root);
    } finally {
      store.close();
    }
  });
});
