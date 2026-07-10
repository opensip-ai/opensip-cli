import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { catalogGenerationKey, createGeneration } from '../catalog-generation.js';

import type { Catalog } from '@opensip-cli/graph';

const identity = {
  language: 'typescript',
  cacheKey: 'ck',
  filesFingerprint: 'fp',
  builtAt: '2026-07-09T00:00:00.000Z',
};

describe('catalogGenerationKey', () => {
  it('returns g1: plus lowercase sha256 of the fixed tuple', () => {
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          'opensip:mcp:catalog-generation',
          1,
          identity.language,
          identity.cacheKey,
          identity.filesFingerprint,
          identity.builtAt,
        ]),
        'utf8',
      )
      .digest('hex');
    expect(catalogGenerationKey(identity)).toBe(`g1:${expected}`);
  });

  it('changes when any identity field drifts', () => {
    const base = catalogGenerationKey(identity);
    expect(catalogGenerationKey({ ...identity, language: 'python' })).not.toBe(base);
    expect(catalogGenerationKey({ ...identity, cacheKey: 'other' })).not.toBe(base);
    expect(catalogGenerationKey({ ...identity, filesFingerprint: 'x' })).not.toBe(base);
    expect(catalogGenerationKey({ ...identity, builtAt: '2020-01-01T00:00:00.000Z' })).not.toBe(
      base,
    );
  });

  it('handles control and unicode components without throwing', () => {
    const key = catalogGenerationKey({
      language: 'ts\u0000',
      cacheKey: 'café',
      filesFingerprint: 'a|b',
      builtAt: identity.builtAt,
    });
    expect(key.startsWith('g1:')).toBe(true);
    expect(key.length).toBe(3 + 64);
  });
});

describe('createGeneration', () => {
  it('stamps key and source', () => {
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: identity.builtAt,
      cacheKey: 'ck',
      filesFingerprint: 'fp',
      functions: {},
    };
    const gen = createGeneration(catalog, 'initial-load', identity);
    expect(gen.key).toBe(catalogGenerationKey(identity));
    expect(gen.source).toBe('initial-load');
    expect(gen.indexes).toBeDefined();
  });
});
