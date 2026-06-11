/**
 * ADR-0020 + ADR-0035: `fit --gate-save` (the `fit:ci` dogfood gate) must
 * HARD-FAIL the step on a fail-threshold breach, not exit 0 and lean on the
 * downstream Code Scanning ratchet. Post-ADR-0035 the hard-fail is the single
 * host verdict: gate-save delivers the run envelope WITHOUT a `runFailed`
 * override, and the host derives the findings exit from `envelope.verdict.passed`
 * (the RUNTIME_ERROR mapping itself is pinned in envelope-routing.test.ts). These
 * tests assert gate-save reaches delivery with the correct envelope verdict.
 *
 * `executeFit` is mocked so the test drives the gate verdict directly via the
 * run envelope's `verdict.passed`.
 */

import { type FitOptions, type SignalEnvelope } from '@opensip-tools/contracts';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../fit.js', () => ({ executeFit: vi.fn() }));

import { runGateMode } from '../fit-modes.js';
import { executeFit } from '../fit.js';

import type { ToolCliContext } from '@opensip-tools/core';

let datastore: DataStore;

/** A run envelope whose single verdict is `passed` (the host's exit driver). */
const envelopeWith = (passed: boolean): SignalEnvelope =>
  ({
    tool: 'fitness',
    schemaVersion: 2,
    units: [],
    signals: [],
    verdict: { passed, score: passed ? 100 : 0, summary: {} },
  }) as unknown as SignalEnvelope;

/** A successful executeFit result carrying the given verdict envelope. */
const fitResult = (passed: boolean): Awaited<ReturnType<typeof executeFit>> => {
  const envelope = envelopeWith(passed);
  return {
    result: { type: 'fit-done', label: 'gate', cwd: '/x', envelope, configFound: true },
    envelope,
  } as unknown as Awaited<ReturnType<typeof executeFit>>;
};

function mockCli(): {
  cli: ToolCliContext;
  setExitCode: ReturnType<typeof vi.fn>;
  deliverSignals: ReturnType<typeof vi.fn>;
} {
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

describe('runGateMode --gate-save (ADR-0020 hard-fail via the host verdict)', () => {
  it('delivers a failing-verdict envelope WITHOUT a runFailed override (the host hard-fails on verdict.passed=false)', async () => {
    vi.mocked(executeFit).mockResolvedValue(fitResult(false));
    const { cli, deliverSignals } = mockCli();

    await runGateMode(gateSaveArgs(), cli);

    // The baseline is still delivered even when the gate fails (SARIF export runs
    // in a separate `if: always()` CI step). gate-save's findings gate IS the host
    // verdict, so it passes no override — the host sets RUNTIME_ERROR from
    // envelope.verdict.passed=false (mapping pinned in envelope-routing.test.ts).
    expect(deliverSignals).toHaveBeenCalledTimes(1);
    const [deliveredEnvelope, opts] = deliverSignals.mock.calls[0] ?? [];
    expect((deliveredEnvelope as SignalEnvelope).verdict.passed).toBe(false);
    expect(opts).not.toHaveProperty('runFailed');
  });

  it('delivers a passing-verdict envelope when the run is clean', async () => {
    vi.mocked(executeFit).mockResolvedValue(fitResult(true));
    const { cli, deliverSignals } = mockCli();

    await runGateMode(gateSaveArgs(), cli);

    expect(deliverSignals).toHaveBeenCalledTimes(1);
    const [deliveredEnvelope, opts] = deliverSignals.mock.calls[0] ?? [];
    expect((deliveredEnvelope as SignalEnvelope).verdict.passed).toBe(true);
    expect(opts).not.toHaveProperty('runFailed');
  });
});
