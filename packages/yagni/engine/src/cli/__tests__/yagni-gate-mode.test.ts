/**
 * ADR-0020 + ADR-0036: `yagni --gate-save` must hard-fail when the findings
 * policy is not satisfied. Yagni findings are warning-rung (`low`/`medium`), so
 * the dogfood gate uses `failOnWarnings` (not `isErrorSignal`).
 */

import { createSignal, type Signal, type ToolCliContext } from '@opensip-cli/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runYagniGateMode } from '../yagni-gate-mode.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';

function signal(over: Partial<Parameters<typeof createSignal>[0]> = {}): Signal {
  return createSignal({
    source: 'yagni',
    severity: 'medium',
    ruleId: 'yagni:unused-config-surface',
    message: 'msg',
    code: { file: 'src/a.ts', line: 1 },
    ...over,
  });
}

function envelopeOf(signals: readonly Signal[], passed = signals.length === 0): SignalEnvelope {
  const warnings = signals.filter((s) => s.severity === 'medium' || s.severity === 'low').length;
  const errors = signals.length - warnings;
  return {
    schemaVersion: 2,
    tool: 'yagni',
    runId: 'test-run',
    createdAt: '1970-01-01T00:00:00.000Z',
    verdict: {
      score: passed ? 100 : 0,
      passed,
      summary: {
        total: signals.length,
        passed: passed ? signals.length : 0,
        failed: passed ? 0 : signals.length,
        errors,
        warnings,
      },
    },
    units: [],
    signals,
    baselineIdentity: {
      fingerprintStrategyId: 'yagni.sha256-detector-locations',
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
  const render = vi.fn((_result: unknown) => Promise.resolve());
  const setExitCode = vi.fn();
  const cli = {
    saveBaseline,
    deliverSignals,
    render,
    setExitCode,
    logger: console,
    reportFailure: vi.fn(async (detail: { exitCode?: number; message?: string }) => {
      if (detail.exitCode !== undefined) setExitCode(detail.exitCode);
      if (detail.message) await render({ type: 'error', message: detail.message });
    }),
  } as unknown as ToolCliContext;
  return { cli, saveBaseline, deliverSignals, render, setExitCode };
}

const executeYagniMock = vi.hoisted(() => vi.fn());
const loadYagniConfigMock = vi.hoisted(() =>
  vi.fn(() => ({
    failOnErrors: 0,
    failOnWarnings: 1,
    defaultMinConfidence: 'medium' as const,
    includeTests: false,
  })),
);

vi.mock('../execute-yagni.js', () => ({
  executeYagni: executeYagniMock,
}));

vi.mock('../yagni-config.js', () => ({
  loadYagniConfig: loadYagniConfigMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runYagniGateMode --gate-save', () => {
  it('saves the baseline and passes runFailed=false when the policy passes', async () => {
    const { cli, saveBaseline, deliverSignals, setExitCode } = mockCli();
    const envelope = envelopeOf([]);
    executeYagniMock.mockResolvedValue({
      envelope,
      session: { tool: 'yagni', cwd: '/x', score: 100, passed: true, payload: {} },
    });

    await runYagniGateMode({ cwd: '/x', gateSave: true }, cli);

    expect(saveBaseline).toHaveBeenCalledWith('yagni', envelope);
    expect(setExitCode).not.toHaveBeenCalled();
    expect(deliverSignals).toHaveBeenCalledWith(
      envelope,
      expect.objectContaining({ runFailed: false }),
    );
  });

  it('feeds runFailed=true when the envelope verdict fails the policy', async () => {
    const { cli, deliverSignals } = mockCli();
    const envelope = envelopeOf([signal()], false);
    executeYagniMock.mockResolvedValue({
      envelope,
      session: { tool: 'yagni', cwd: '/x', score: 0, passed: false, payload: {} },
    });

    await runYagniGateMode({ cwd: '/x', gateSave: true }, cli);

    expect(deliverSignals).toHaveBeenCalledWith(
      envelope,
      expect.objectContaining({ runFailed: true }),
    );
  });
});
