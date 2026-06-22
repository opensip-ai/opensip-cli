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
    scope: { datastore: () => ({}) },
    getExitCode: () => state.code,
    setExitCode: (code: number) => {
      state.code = code;
    },
    _exitState: state,
  } as unknown as ToolCliContext & { _exitState: { code?: number } };
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
});
