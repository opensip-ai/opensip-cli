/**
 * Audit P1-2: cloud signal emit must fire in graph's gate / report / catalog
 * modes, not only the default dashboard-populating render. Previously those
 * modes early-returned before the (session-coupled) emit, so an entitled sink
 * received nothing from a `graph --gate-save`, `--report-to`, or
 * `--catalog-output` run. These tests spy the emit seam per mode.
 */

import { emitRunSignals } from '@opensip-tools/reporting';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';


import { runCatalogJsonMode, runGateMode, runReportMode } from '../graph-modes.js';
import { dispatchGraphResult } from '../graph.js';

import type { ToolCliContext } from '@opensip-tools/core';

// Stub the mode handlers (they own datastore / network / file IO) and the emit
// seam, so the test isolates dispatchGraphResult's "which modes emit" logic.
vi.mock('../graph-modes.js', () => ({
  runGateMode: vi.fn().mockResolvedValue(undefined),
  runReportMode: vi.fn().mockResolvedValue(undefined),
  runCatalogJsonMode: vi.fn(),
}));
vi.mock('@opensip-tools/reporting', () => ({ emitRunSignals: vi.fn().mockResolvedValue(undefined) }));

const emitMock = emitRunSignals as unknown as MockInstance;

const result = { signals: [], catalog: undefined } as unknown as Parameters<typeof dispatchGraphResult>[1];

function mockCli(): ToolCliContext {
  return {
    setExitCode: vi.fn(),
    logger: console,
    scope: { signalSink: { emit: vi.fn() }, datastore: () => undefined },
  } as unknown as ToolCliContext;
}

const STARTED = '2026-06-03T00:00:00.000Z';

beforeEach(() => {
  emitMock.mockClear();
  (runGateMode as unknown as MockInstance).mockClear();
  (runReportMode as unknown as MockInstance).mockClear();
  (runCatalogJsonMode as unknown as MockInstance).mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('graph cloud signal emit per mode (audit P1-2)', () => {
  it('emits in --gate-save mode', async () => {
    const opts = { gateSave: true, cwd: '/x' } as unknown as Parameters<typeof dispatchGraphResult>[0];
    await dispatchGraphResult(opts, result, mockCli(), STARTED);
    expect(runGateMode).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  it('emits in --report-to mode', async () => {
    const opts = { reportTo: 'https://sink.example', cwd: '/x' } as unknown as Parameters<typeof dispatchGraphResult>[0];
    await dispatchGraphResult(opts, result, mockCli(), STARTED);
    expect(runReportMode).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  it('emits in --catalog-output mode', async () => {
    const opts = { catalogOutput: 'out/cat.json', cwd: '/x' } as unknown as Parameters<typeof dispatchGraphResult>[0];
    await dispatchGraphResult(opts, result, mockCli(), STARTED);
    expect(runCatalogJsonMode).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledTimes(1);
  });
});
