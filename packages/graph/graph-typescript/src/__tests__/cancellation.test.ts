import { describe, expect, it } from 'vitest';

import { typescriptGraphAdapter } from '../index.js';

import type { Catalog } from '@opensip-cli/graph';

function cancelledSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

const catalog: Catalog = {
  version: '3.0',
  tool: 'graph',
  language: 'typescript',
  builtAt: '2026-07-26T00:00:00.000Z',
  cacheKey: 'test',
  functions: {},
};

describe('TypeScript graph adapter cancellation', () => {
  it('checks cancellation in discovery, parse, walk, and cache-key operations', () => {
    const signal = cancelledSignal();
    expect(() =>
      typescriptGraphAdapter.discoverFiles({
        cwd: process.cwd(),
        diagnosticIntent: 'quiet',
        signal,
      }),
    ).toThrow(expect.objectContaining({ code: 'CORE.SYSTEM.CANCELLED' }));
    expect(() =>
      typescriptGraphAdapter.parseProject({
        projectDirAbs: process.cwd(),
        files: [],
        resolutionMode: 'fast',
        signal,
      }),
    ).toThrow(expect.objectContaining({ code: 'CORE.SYSTEM.CANCELLED' }));
    expect(() =>
      typescriptGraphAdapter.walkProject({
        project: { kind: 'fast', sourceFiles: new Map() },
        projectDirAbs: process.cwd(),
        files: [],
        signal,
      }),
    ).toThrow(expect.objectContaining({ code: 'CORE.SYSTEM.CANCELLED' }));
    expect(() =>
      typescriptGraphAdapter.cacheKey({
        projectDirAbs: process.cwd(),
        resolutionMode: 'fast',
        signal,
      }),
    ).toThrow(expect.objectContaining({ code: 'CORE.SYSTEM.CANCELLED' }));
  });

  it('checks cancellation before call-site resolution', async () => {
    const signal = cancelledSignal();
    await expect(
      typescriptGraphAdapter.resolveCallSites({
        project: { kind: 'fast', sourceFiles: new Map() },
        catalog,
        callSites: [],
        projectDirAbs: process.cwd(),
        resolutionMode: 'fast',
        signal,
      }),
    ).rejects.toMatchObject({ code: 'CORE.SYSTEM.CANCELLED' });
  });
});
