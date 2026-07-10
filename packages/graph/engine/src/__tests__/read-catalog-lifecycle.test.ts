import { describe, expect, it } from 'vitest';

import {
  isSafeAdapterDescriptor,
  verifyCatalogInputs,
  type GraphAdapterRegistryReader,
} from '../read/index.js';

import type { GraphLanguageAdapter } from '../lang-adapter/types.js';
import type { Catalog } from '../types.js';

function stubAdapter(id: string, files: readonly string[] = []): GraphLanguageAdapter {
  return {
    id,
    fileExtensions: [`.${id.slice(0, 2)}`],
    displayName: id,
    discoverFiles: () => ({
      projectDirAbs: '/proj',
      files: [...files],
    }),
    parseProject: () => ({ project: null, parseErrors: [] }),
    walkProject: () => ({ occurrences: {}, callSites: [], parseErrors: [] }),
    resolveCallSites: () => ({
      edgesByOwner: new Map(),
      stats: {
        totalCallSites: 0,
        resolvedHigh: 0,
        resolvedMedium: 0,
        resolvedLow: 0,
        unresolved: 0,
      },
    }),
    cacheKey: () => `${id}-v1`,
  };
}

function registryOf(...adapters: GraphLanguageAdapter[]): GraphAdapterRegistryReader {
  const map = new Map(adapters.map((a) => [a.id, a]));
  return {
    get size() {
      return map.size;
    },
    getAll: () => [...map.entries()].map(([id, adapter]) => ({ id, adapter })),
    getById: (id) => {
      const adapter = map.get(id);
      return adapter === undefined ? undefined : { adapter };
    },
  };
}

function catalog(partial: Partial<Catalog> = {}): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-09T00:00:00.000Z',
    cacheKey: 'ts-v1',
    filesFingerprint: '0',
    functions: {},
    ...partial,
  };
}

describe('isSafeAdapterDescriptor', () => {
  it('accepts a well-formed adapter and rejects hostile ones', () => {
    expect(isSafeAdapterDescriptor(stubAdapter('typescript'))).toBe(true);
    expect(
      isSafeAdapterDescriptor({
        ...stubAdapter('typescript'),
        id: 'a'.repeat(100),
      }),
    ).toBe(false);
    expect(
      isSafeAdapterDescriptor({
        ...stubAdapter('typescript'),
        fileExtensions: Array.from({ length: 40 }, () => '.ts'),
      }),
    ).toBe(false);
  });
});

describe('verifyCatalogInputs', () => {
  it('returns partial when provenance is absent', async () => {
    const result = await verifyCatalogInputs({
      projectRoot: '/proj',
      catalog: catalog(),
      adapters: registryOf(stubAdapter('typescript')),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verification).toBe('partial');
    expect(result.value.fresh).toBe(false);
    expect(result.value.reasonCode).toBe('verification-unavailable');
  });

  it('detects selection drift when a different adapter is selected', async () => {
    const result = await verifyCatalogInputs({
      projectRoot: '/proj',
      catalog: catalog({
        language: 'typescript',
        adapterSelection: { mode: 'forced', requestedId: 'typescript', selectedId: 'typescript' },
        engineMode: 'exact',
      }),
      adapters: registryOf(stubAdapter('python')),
    });
    // Forced request for typescript with only python registered → selection error.
    expect(result.ok).toBe(false);
  });
});
