import { EXIT_CODES } from '@opensip-cli/contracts';
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

function cliWithDatastore(exit?: { prior?: number; current?: number }): ToolCliContext {
  const state = { code: exit?.prior };
  return {
    // A graph adapter is registered → `auto` rebuilds via executeGraph.
    scope: { datastore: () => ({}), graph: { adapters: { size: 1 } } },
    getExitCode: () => state.code,
    setExitCode: (code: number) => {
      state.code = code;
    },
    _exitState: state,
  } as unknown as ToolCliContext & { _exitState: { code?: number } };
}

/** Datastore present, but NO graph adapter registered (a plain `yagni` run). */
function cliNoGraphAdapter(): ToolCliContext {
  return {
    scope: { datastore: () => ({}), graph: { adapters: { size: 0 } } },
  } as unknown as ToolCliContext;
}

function cliWithoutDatastore(): ToolCliContext {
  return {
    scope: { datastore: () => undefined },
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

  it('auto mode without a graph adapter reuses the cached catalog (no executeGraph, no warning)', async () => {
    graphMocks.loadCatalogContract.mockReturnValue(CATALOG);

    const result = await resolveGraphEvidence('/repo', 'auto', cliNoGraphAdapter());

    // executeGraph would log "no language adapter is registered" to stderr;
    // the degraded path must NOT call it.
    expect(graphMocks.executeGraph).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      catalog: CATALOG,
      mode: 'auto',
      built: false,
      detail: 'reused cached catalog (no adapter to rebuild)',
    });
  });

  it('auto mode returns null when there is no graph adapter and no cached catalog', async () => {
    graphMocks.loadCatalogContract.mockReturnValue(null);

    const result = await resolveGraphEvidence('/repo', 'auto', cliNoGraphAdapter());

    expect(graphMocks.executeGraph).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      catalog: null,
      mode: 'auto',
      built: false,
      detail: 'no graph adapter; no cached catalog',
    });
  });

  it('clears exit codes set by executeGraph so yagni stays advisory', async () => {
    graphMocks.loadCatalogContract.mockReturnValue(CATALOG);
    graphMocks.executeGraph.mockImplementation((_opts, cli) => {
      cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
      return Promise.resolve();
    });
    const cli = cliWithDatastore();

    await resolveGraphEvidence('/repo', 'build', cli);

    expect((cli as ToolCliContext & { _exitState: { code?: number } })._exitState.code).toBe(
      EXIT_CODES.SUCCESS,
    );
  });

  it('restores a pre-existing exit code when graph mutates it', async () => {
    graphMocks.loadCatalogContract.mockReturnValue(CATALOG);
    graphMocks.executeGraph.mockImplementation((_opts, cli) => {
      cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
      return Promise.resolve();
    });
    const cli = cliWithDatastore({ prior: EXIT_CODES.REPORT_FAILED });

    await resolveGraphEvidence('/repo', 'auto', cli);

    expect((cli as ToolCliContext & { _exitState: { code?: number } })._exitState.code).toBe(
      EXIT_CODES.REPORT_FAILED,
    );
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

  it('returns explicit details for disabled, unavailable, and missing cached graph evidence', async () => {
    await expect(
      resolveGraphEvidence('/repo', 'off', cliWithoutDatastore()),
    ).resolves.toMatchObject({
      catalog: null,
      mode: 'off',
      built: false,
      detail: 'graph disabled',
    });

    await expect(
      resolveGraphEvidence('/repo', 'reuse', cliWithoutDatastore()),
    ).resolves.toMatchObject({
      catalog: null,
      mode: 'reuse',
      built: false,
      detail: 'datastore unavailable',
    });

    graphMocks.loadCatalogContract.mockReturnValue(null);
    await expect(resolveGraphEvidence('/repo', 'reuse', cliWithDatastore())).resolves.toMatchObject(
      {
        catalog: null,
        mode: 'reuse',
        built: false,
        detail: 'no cached catalog',
      },
    );
  });

  it('reports null catalog outcomes from build and auto modes', async () => {
    graphMocks.loadCatalogContract.mockReturnValue(null);

    await expect(resolveGraphEvidence('/repo', 'build', cliWithDatastore())).resolves.toMatchObject(
      {
        catalog: null,
        mode: 'build',
        built: false,
        detail: 'graph build produced no catalog',
      },
    );

    await expect(resolveGraphEvidence('/repo', 'auto', cliWithDatastore())).resolves.toMatchObject({
      catalog: null,
      mode: 'auto',
      built: false,
      detail: 'auto build produced no catalog',
    });
  });
});
