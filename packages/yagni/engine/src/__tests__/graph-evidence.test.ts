import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveGraphEvidence } from '../evidence/graph-evidence.js';

import type { GraphCatalog } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';

const graphMocks = vi.hoisted(() => {
  const loadCatalogContract = vi.fn();
  const executeGraph = vi.fn();
  const CatalogRepo = vi.fn().mockImplementation(function CatalogRepo() {
    return { loadCatalogContract };
  });
  return { CatalogRepo, executeGraph, loadCatalogContract };
});

vi.mock('@opensip-cli/graph/internal', () => ({
  CatalogRepo: graphMocks.CatalogRepo,
  executeGraph: graphMocks.executeGraph,
}));

const CATALOG: GraphCatalog = {
  version: '1',
  tool: 'graph',
  language: 'typescript',
  builtAt: '2026-06-21T00:00:00.000Z',
  functions: {},
};

function cliWithDatastore(): ToolCliContext {
  return {
    scope: { datastore: () => ({}) },
  } as unknown as ToolCliContext;
}

describe('resolveGraphEvidence', () => {
  beforeEach(() => {
    graphMocks.CatalogRepo.mockClear();
    graphMocks.executeGraph.mockReset();
    graphMocks.executeGraph.mockResolvedValue(undefined);
    graphMocks.loadCatalogContract.mockReset();
  });

  it('forces a graph rebuild in build mode', async () => {
    graphMocks.loadCatalogContract.mockReturnValue(CATALOG);
    const cli = cliWithDatastore();

    const result = await resolveGraphEvidence('/repo', 'build', cli);

    expect(graphMocks.executeGraph).toHaveBeenCalledWith(
      { cwd: '/repo', json: true, noCache: true },
      cli,
    );
    expect(result).toMatchObject({
      catalog: CATALOG,
      mode: 'build',
      built: true,
      detail: 'built fresh catalog',
    });
  });

  it('delegates auto mode to graph cache validation instead of direct catalog reuse', async () => {
    graphMocks.loadCatalogContract.mockReturnValue(CATALOG);
    const cli = cliWithDatastore();

    const result = await resolveGraphEvidence('/repo', 'auto', cli);

    expect(graphMocks.executeGraph).toHaveBeenCalledWith(
      { cwd: '/repo', json: true, noCache: false },
      cli,
    );
    expect(result).toMatchObject({
      catalog: CATALOG,
      mode: 'auto',
      built: false,
      detail: 'auto resolved graph catalog',
    });
  });

  it('reuses a persisted catalog without invoking graph in reuse mode', async () => {
    graphMocks.loadCatalogContract.mockReturnValue(CATALOG);
    const cli = cliWithDatastore();

    const result = await resolveGraphEvidence('/repo', 'reuse', cli);

    expect(graphMocks.executeGraph).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      catalog: CATALOG,
      mode: 'reuse',
      built: false,
      detail: 'reused cached catalog',
    });
  });
});
