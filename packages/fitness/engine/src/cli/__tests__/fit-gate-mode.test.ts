/**
 * ADR-0020: `fit --gate-save` (the `fit:ci` dogfood gate) must HARD-FAIL the
 * step on a fail-threshold breach (`failOnErrors`/`failOnWarnings`), not exit 0
 * and lean entirely on the downstream Code Scanning net-new ratchet. These tests
 * pin that exit-code contract for `runGateMode`'s gate-save branch.
 *
 * `executeFit` is mocked so the test drives the gate verdict directly via the
 * run's `shouldFail` — the threshold computation itself is covered by
 * result-builders; here we assert gate-save reacts to it.
 */

import { EXIT_CODES, type FitOptions, type SignalEnvelope } from '@opensip-tools/contracts';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../fit.js', () => ({ executeFit: vi.fn() }));

import { runGateMode } from '../fit-modes.js';
import { executeFit } from '../fit.js';

import type { ToolCliContext } from '@opensip-tools/core';

let datastore: DataStore;

const fakeEnvelope = {
  tool: 'fitness',
  schemaVersion: 2,
  units: [],
  signals: [],
  verdict: { passed: false, score: 0 },
} as unknown as SignalEnvelope;

/** A successful executeFit result whose run verdict is `shouldFail`. */
const fitResult = (shouldFail: boolean): Awaited<ReturnType<typeof executeFit>> =>
  ({
    result: { type: 'fit-done', label: 'gate', cwd: '/x', envelope: fakeEnvelope, shouldFail, configFound: true },
    envelope: fakeEnvelope,
  }) as unknown as Awaited<ReturnType<typeof executeFit>>;

function mockCli(): { cli: ToolCliContext; setExitCode: ReturnType<typeof vi.fn>; deliverSignals: ReturnType<typeof vi.fn> } {
  const setExitCode = vi.fn();
  const deliverSignals = vi.fn(() => Promise.resolve());
  const cli = {
    setExitCode,
    deliverSignals,
    render: vi.fn(() => Promise.resolve()),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    emitJson: vi.fn(),
    logger: console,
    scope: { datastore: () => datastore },
  } as unknown as ToolCliContext;
  return { cli, setExitCode, deliverSignals };
}

function gateSaveArgs(): FitOptions {
  return {
    json: false,
    list: false,
    recipes: false,
    verbose: false,
    findings: false,
    debug: false,
    quiet: true,
    open: false,
    cwd: '/x',
    exclude: [],
    gateSave: true,
    gateCompare: false,
  };
}

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  vi.clearAllMocks();
});

afterEach(() => {
  datastore.close();
  vi.restoreAllMocks();
});

describe('runGateMode --gate-save (ADR-0020 hard-fail)', () => {
  it('hard-fails the step (exit RUNTIME_ERROR) when the run breaches the fail threshold', async () => {
    vi.mocked(executeFit).mockResolvedValue(fitResult(true));
    const { cli, setExitCode, deliverSignals } = mockCli();

    await runGateMode(gateSaveArgs(), cli);

    expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
    // The baseline is still delivered even though the gate failed (SARIF export
    // runs in a separate `if: always()` CI step), with runFailed=true so a
    // report-to failure can't mask the gate verdict.
    expect(deliverSignals).toHaveBeenCalledWith(
      fakeEnvelope,
      expect.objectContaining({ runFailed: true }),
    );
  });

  it('passes the step (no error exit) when the run is clean', async () => {
    vi.mocked(executeFit).mockResolvedValue(fitResult(false));
    const { cli, setExitCode, deliverSignals } = mockCli();

    await runGateMode(gateSaveArgs(), cli);

    expect(setExitCode).not.toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
    expect(deliverSignals).toHaveBeenCalledWith(
      fakeEnvelope,
      expect.objectContaining({ runFailed: false }),
    );
  });
});
