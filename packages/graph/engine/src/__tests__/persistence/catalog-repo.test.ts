import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CatalogRepo } from '../../persistence/catalog-repo.js';

import type { Catalog } from '../../types.js';

function makeCatalog(over: Partial<Catalog> = {}): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-05-22T00:00:00.000Z',
    cacheKey: 'ts-5.7.3-test',
    filesFingerprint: '0\n',
    functions: {},
    ...over,
  };
}

let datastore: DataStore;
let repo: CatalogRepo;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  repo = new CatalogRepo(datastore);
});

afterEach(() => {
  datastore.close();
});

describe('CatalogRepo', () => {
  it('hasAnyCatalog returns false on empty store', () => {
    expect(repo.hasAnyCatalog()).toBe(false);
  });

  it('replaceAll then loadFullCatalog round-trips a catalog', () => {
    const c = makeCatalog({
      functions: {
        foo: [
          {
            bodyHash: 'h1',
            simpleName: 'foo',
            qualifiedName: 'foo',
            filePath: 'a.ts',
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
      },
    });
    repo.replaceAll(c);
    expect(repo.hasAnyCatalog()).toBe(true);
    const loaded = repo.loadFullCatalog();
    expect(loaded).not.toBeNull();
    expect(loaded?.language).toBe('typescript');
    expect(Object.keys(loaded?.functions ?? {})).toContain('foo');
  });

  it('replaceAll with a second catalog overwrites the first', () => {
    repo.replaceAll(makeCatalog({ language: 'typescript' }));
    repo.replaceAll(makeCatalog({ language: 'python' }));
    expect(repo.loadFullCatalog()?.language).toBe('python');
  });

  it('loadFullCatalog returns null on empty store', () => {
    expect(repo.loadFullCatalog()).toBeNull();
  });

  it('falls back to empty filesFingerprint when input lacks it', () => {
    const { filesFingerprint, ...withoutFp } = makeCatalog();
    void filesFingerprint;
    repo.replaceAll(withoutFp);
    expect(repo.loadFullCatalog()?.filesFingerprint).toBeUndefined();
  });

  it('replaceAll error branch propagates after datastore close', () => {
    datastore.close();
    expect(() => repo.replaceAll(makeCatalog())).toThrow();
  });

  it('loadFullCatalog error branch propagates after datastore close', () => {
    datastore.close();
    expect(() => repo.loadFullCatalog()).toThrow();
  });
});
