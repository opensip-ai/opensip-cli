import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError } from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { describe, expect, it, vi } from 'vitest';

import { CatalogRepo } from '../../persistence/catalog-repo.js';
import { executeImpact } from '../impact.js';

import type { Catalog } from '../../types.js';
import type { ToolCliContext } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

function makeCatalog(over: Partial<Catalog> = {}): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-05-22T00:00:00.000Z',
    cacheKey: 'ts-test',
    filesFingerprint: '0\n',
    functions: {
      callee: [
        {
          bodyHash: 'callee',
          simpleName: 'callee',
          qualifiedName: 'callee',
          filePath: 'src/callee.ts',
          line: 1,
          column: 0,
          endLine: 5,
          kind: 'function-declaration',
          params: [],
          returnType: null,
          enclosingClass: null,
          decorators: [],
          visibility: 'exported',
          inTestFile: false,
          definedInGenerated: false,
          calls: [],
        },
      ],
      caller: [
        {
          bodyHash: 'caller',
          simpleName: 'caller',
          qualifiedName: 'caller',
          filePath: 'src/caller.ts',
          line: 1,
          column: 0,
          endLine: 8,
          kind: 'function-declaration',
          params: [],
          returnType: null,
          enclosingClass: null,
          decorators: [],
          visibility: 'exported',
          inTestFile: false,
          definedInGenerated: false,
          calls: [
            {
              to: ['callee'],
              line: 2,
              column: 4,
              resolution: 'static',
              confidence: 'high',
              text: 'callee()',
            },
          ],
        },
      ],
    },
    ...over,
  };
}

function mockCli(datastore: DataStore): ToolCliContext {
  return {
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    render: vi.fn().mockResolvedValue(undefined),
    scope: { datastore: () => datastore },
  } as unknown as ToolCliContext;
}

describe('executeImpact', () => {
  it('--files works without git and returns graph-impact result', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const result = await executeImpact(
      {
        cwd: '/proj',
        json: true,
        files: ['src/callee.ts'],
      },
      cli,
    );
    expect(result.type).toBe('graph-impact');
    expect(result.changedFiles).toContain('src/callee.ts');
    expect(result.changedFunctions.some((f) => f.qualifiedName === 'callee')).toBe(true);
    expect(result.recommendedCommands.length).toBeGreaterThan(0);
    datastore.close();
  });

  it('--changed outside a git repo throws ConfigurationError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-impact-nogit-'));
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    await expect(
      executeImpact({ cwd: dir, json: true, changed: true }, cli),
    ).rejects.toBeInstanceOf(ConfigurationError);
    datastore.close();
  });

  it('rejects path traversal in --files (matches nothing, no filesystem read)', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const result = await executeImpact(
      {
        cwd: mkdtempSync(join(tmpdir(), 'opensip-impact-traversal-')),
        json: true,
        files: ['../../etc/passwd'],
      },
      cli,
    );
    expect(result.changedFunctions).toHaveLength(0);
    expect(result.impactedFunctions).toHaveLength(0);
    datastore.close();
  });

  it('applies --top cap and sets truncated', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const result = await executeImpact(
      {
        cwd: '/proj',
        json: true,
        files: ['src/callee.ts'],
        top: '1',
      },
      cli,
    );
    expect(result.truncated).toBe(true);
    datastore.close();
  });
});
