/**
 * ADR-0020 + ADR-0036: `graph --gate-save` (the `graph:ci` dogfood gate) must
 * HARD-FAIL the step on an error-level finding (core's `isErrorSignal` rung:
 * `critical`/`high`). Post-ADR-0036 the exit is HOST-owned: `runGateMode` no
 * longer calls `setExitCode` — it persists via the `cli.saveBaseline` seam and
 * feeds the findings verdict to the host's `cli.deliverSignals` runFailed
 * override (the host derives RUNTIME_ERROR). These tests pin that contract for the
 * gate-save branch.
 *
 * The envelope's signal set reaching `runGateMode` is the already
 * suppression-filtered (`@graph-ignore`, ADR-0014) `kept` set, so an error-rung
 * signal here is by definition UNSUPPRESSED — exactly what should trip the gate.
 */

import { createSignal, type Signal, type ToolCliContext } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeReportFailureMock } from '../../__tests__/report-failure-mock.js';
import { runGateMode } from '../graph-modes.js';

import type { GraphCommandOptions } from '../graph-options.js';
import type { SignalEnvelope } from '@opensip-cli/contracts';

function signal(over: Partial<Parameters<typeof createSignal>[0]> = {}): Signal {
  return createSignal({
    source: 'graph',
    severity: 'medium',
    ruleId: 'graph:wide-function',
    message: 'msg',
    code: { file: 'src/a.ts', line: 1 },
    ...over,
  });
}

function envelopeOf(signals: readonly Signal[]): SignalEnvelope {
  return {
    schemaVersion: 2,
    tool: 'graph',
    runId: 'test-run',
    createdAt: '1970-01-01T00:00:00.000Z',
    verdict: {
      score: 0,
      passed: true,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
    },
    units: [],
    signals,
    baselineIdentity: {
      fingerprintStrategyId: 'graph.rule-file-line-col',
      fingerprintStrategyVersion: 1,
    },
  };
}

function mockCli(): {
  cli: ToolCliContext;
  saveBaseline: ReturnType<typeof vi.fn>;
  deliverSignals: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  setExitCode: ReturnType<typeof vi.fn>;
} {
  const saveBaseline = vi.fn(() => Promise.resolve());
  const deliverSignals = vi.fn(() => Promise.resolve());
  const render = vi.fn(() => Promise.resolve());
  const setExitCode = vi.fn();
  const cli = {
    saveBaseline,
    deliverSignals,
    render,
    setExitCode,
    logger: console,
    reportFailure: makeReportFailureMock(setExitCode, render),
  } as unknown as ToolCliContext;
  return { cli, saveBaseline, deliverSignals, render, setExitCode };
}

function gateSaveOpts(): GraphCommandOptions {
  return { cwd: '/x', gateSave: true };
}

/** Pull the runFailed override out of the (single) deliverSignals call. */
function deliveredRunFailed(deliverSignals: ReturnType<typeof vi.fn>): boolean | undefined {
  expect(deliverSignals).toHaveBeenCalledTimes(1);
  return (deliverSignals.mock.calls[0][1] as { runFailed?: boolean }).runFailed;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runGateMode --gate-save (ADR-0020 graph hard-fail, ADR-0036 host-owned exit)', () => {
  it('saves the baseline and never calls setExitCode (the host owns the exit)', async () => {
    const { cli, saveBaseline, setExitCode } = mockCli();
    await runGateMode(gateSaveOpts(), envelopeOf([]), cli, 'exact');
    expect(saveBaseline).toHaveBeenCalledWith('graph', expect.objectContaining({ tool: 'graph' }));
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('passes the step (runFailed false) when the unsuppressed signal set is clean', async () => {
    const { cli, deliverSignals } = mockCli();
    await runGateMode(gateSaveOpts(), envelopeOf([]), cli, 'exact');
    expect(deliveredRunFailed(deliverSignals)).toBe(false);
  });

  it('still passes when only warning-rung (medium/low) findings are present', async () => {
    const { cli, deliverSignals } = mockCli();
    await runGateMode(
      gateSaveOpts(),
      envelopeOf([signal({ severity: 'medium' }), signal({ severity: 'low' })]),
      cli,
      'exact',
    );
    expect(deliveredRunFailed(deliverSignals)).toBe(false);
  });

  it('hard-fails (runFailed true) when an error-rung (high/critical) finding is present', async () => {
    const { cli, deliverSignals, render } = mockCli();
    await runGateMode(
      gateSaveOpts(),
      envelopeOf([signal({ severity: 'medium' }), signal({ severity: 'high' })]),
      cli,
      'exact',
    );
    expect(deliveredRunFailed(deliverSignals)).toBe(true);
    // The baseline is still saved (rendered) even though the gate failed — the
    // SARIF export runs in a separate `if: always()` CI step.
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gate-done',
        lines: expect.arrayContaining([expect.stringContaining('Graph gate FAILED')]),
      }),
    );
  });
});
