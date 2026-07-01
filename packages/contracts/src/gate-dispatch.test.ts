import { describe, expect, it, vi } from 'vitest';

import { runHostGateDispatch } from './gate-dispatch.js';

import type { SignalEnvelope } from './signal-envelope.js';
import type { GateCompareResult, ToolCliContext } from '@opensip-cli/core';

function envelopeOf(passed = true): SignalEnvelope {
  return {
    schemaVersion: 2,
    tool: 'test-tool',
    runId: 'RUN_test',
    createdAt: '1970-01-01T00:00:00.000Z',
    verdict: {
      score: passed ? 100 : 0,
      passed,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
    },
    units: [],
    signals: [],
    baselineIdentity: {
      fingerprintStrategyId: 'test.strategy',
      fingerprintStrategyVersion: 1,
    },
  };
}

function compareResult(degraded: boolean): GateCompareResult {
  return {
    added: [],
    resolved: [],
    unchanged: [],
    degraded,
  };
}

function makeCli(result = compareResult(false)): {
  readonly cli: ToolCliContext;
  readonly saveBaseline: ReturnType<typeof vi.fn>;
  readonly compareBaseline: ReturnType<typeof vi.fn>;
  readonly render: ReturnType<typeof vi.fn>;
  readonly deliverSignals: ReturnType<typeof vi.fn>;
  readonly writeSarif: ReturnType<typeof vi.fn>;
} {
  const saveBaseline = vi.fn(() => Promise.resolve());
  const compareBaseline = vi.fn(() => Promise.resolve(result));
  const render = vi.fn(() => Promise.resolve());
  const deliverSignals = vi.fn(() => Promise.resolve({ cloudAccepted: 0 }));
  const writeSarif = vi.fn(() => Promise.resolve());
  return {
    cli: {
      saveBaseline,
      compareBaseline,
      render,
      deliverSignals,
      writeSarif,
    } as unknown as ToolCliContext,
    saveBaseline,
    compareBaseline,
    render,
    deliverSignals,
    writeSarif,
  };
}

describe('runHostGateDispatch', () => {
  it('saves a baseline, renders gate lines, and lets delivery derive save verdict by default', async () => {
    const { cli, saveBaseline, render, deliverSignals } = makeCli();
    const envelope = envelopeOf(false);

    const result = await runHostGateDispatch({
      cli,
      tool: 'fitness',
      envelope,
      mode: 'save',
      deliver: { cwd: '/repo' },
      renderSaveLines: ({ runFailed }) => [`saved ${String(runFailed)}`],
      renderCompareLines: () => [],
    });

    expect(saveBaseline).toHaveBeenCalledWith('fitness', envelope);
    expect(render).toHaveBeenCalledWith({ type: 'gate-done', lines: ['saved true'] });
    expect(deliverSignals).toHaveBeenCalledWith(envelope, { cwd: '/repo' });
    expect(result).toEqual({ mode: 'save' });
  });

  it('can pass an explicit gate-save runFailed override and write SARIF', async () => {
    const { cli, deliverSignals, writeSarif } = makeCli();
    const envelope = envelopeOf(true);

    await runHostGateDispatch({
      cli,
      tool: 'graph',
      envelope,
      mode: 'save',
      deliver: { cwd: '/repo', reportTo: 'https://example.test', apiKey: 'k' },
      sarifPath: 'graph.sarif',
      saveRunFailed: () => true,
      renderSaveLines: ({ runFailed }) => [`failed ${String(runFailed)}`],
      renderCompareLines: () => [],
    });

    expect(deliverSignals).toHaveBeenCalledWith(envelope, {
      cwd: '/repo',
      reportTo: 'https://example.test',
      apiKey: 'k',
      runFailed: true,
    });
    expect(writeSarif).toHaveBeenCalledWith(envelope, 'graph.sarif');
  });

  it('compares a baseline and uses degraded plus failOnDegraded as the default verdict', async () => {
    const gateResult = compareResult(true);
    const { cli, compareBaseline, render, deliverSignals } = makeCli(gateResult);
    const envelope = envelopeOf(true);

    const result = await runHostGateDispatch({
      cli,
      tool: 'graph',
      envelope,
      mode: 'compare',
      deliver: { cwd: '/repo' },
      renderSaveLines: () => [],
      renderCompareLines: ({ result: compare, runFailed }) => [
        `${String(compare.degraded)} ${String(runFailed)}`,
      ],
    });

    expect(compareBaseline).toHaveBeenCalledWith('graph', envelope);
    expect(render).toHaveBeenCalledWith({ type: 'gate-done', lines: ['true true'] });
    expect(deliverSignals).toHaveBeenCalledWith(envelope, { cwd: '/repo', runFailed: true });
    expect(result).toEqual({ mode: 'compare', result: gateResult, runFailed: true });
  });

  it('allows a custom gate-compare verdict override', async () => {
    const gateResult = compareResult(true);
    const { cli, deliverSignals } = makeCli(gateResult);
    const envelope = envelopeOf(true);

    await runHostGateDispatch({
      cli,
      tool: 'advisory-tool',
      envelope,
      mode: 'compare',
      deliver: { cwd: '/repo' },
      compareRunFailed: () => false,
      renderSaveLines: () => [],
      renderCompareLines: () => ['compare'],
    });

    expect(deliverSignals).toHaveBeenCalledWith(envelope, { cwd: '/repo', runFailed: false });
  });
});
