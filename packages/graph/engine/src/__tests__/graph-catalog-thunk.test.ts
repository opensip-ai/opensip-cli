import { RunScope, runWithScopeSync } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { createGraphCatalogThunk } from '../graph-catalog-thunk.js';

const loadCatalogContract = vi.fn(() => ({ id: 'catalog' }));

vi.mock('../persistence/catalog-repo.js', () => ({
  CatalogRepo: class {
    loadCatalogContract = loadCatalogContract;
  },
}));

describe('createGraphCatalogThunk', () => {
  it('returns null when no scope datastore is available', () => {
    const thunk = createGraphCatalogThunk();
    expect(thunk()).toBeNull();
  });

  it('loads the catalog contract from the current scope datastore', () => {
    const thunk = createGraphCatalogThunk();
    const scope = new RunScope({
      datastore: () => ({ kind: 'memory' }),
    });
    const value = runWithScopeSync(scope, () => thunk());
    expect(value).toEqual({ id: 'catalog' });
    expect(loadCatalogContract).toHaveBeenCalled();
  });
});
