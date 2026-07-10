import { describe, expect, it, expectTypeOf } from 'vitest';

import * as read from '../read/index.js';

const EXPECTED = [
  'readCatalogIdentity',
  'loadCatalogGeneration',
  'rebuildCatalog',
  'buildGraphReadIndexes',
  'deriveGraphReadFeatures',
  'evaluateGraphOrphans',
  'classifyGraphReadCatalog',
  'computeGraphReadFilesFingerprint',
].sort();

describe('@opensip-cli/graph/read public surface', () => {
  it('exposes exactly the locked value surface', () => {
    const actual = Object.keys(read)
      .filter((k) => (read as Record<string, unknown>)[k] !== undefined)
      .sort();
    expect(actual).toEqual(EXPECTED);
  });

  it('does not export repository or rule values', () => {
    for (const leak of ['CatalogRepo', 'orphanSubtreeRule', 'runGraph', 'buildIndexes']) {
      expect(read).not.toHaveProperty(leak);
    }
  });

  it('locks GraphReadError shape at type level', () => {
    type E = read.GraphReadError;
    expectTypeOf<E>().toHaveProperty('code');
    expectTypeOf<E>().toHaveProperty('message');
    expectTypeOf<E>().toHaveProperty('operation');
  });
});
