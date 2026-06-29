import { type ToolCliContext } from '@opensip-cli/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildYagniCommandSpec } from '../yagni-command-spec.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';

const executeYagniMock = vi.hoisted(() => vi.fn());
const loadYagniConfigMock = vi.hoisted(() =>
  vi.fn(() => ({
    failOnErrors: 0,
    failOnWarnings: 1,
    defaultMinConfidence: 'medium' as const,
    includeTests: false,
  })),
);
const runYagniGateModeMock = vi.hoisted(() => vi.fn());
const applyAdvisoryExitCodeMock = vi.hoisted(() => vi.fn());

vi.mock('../execute-yagni.js', () => ({
  executeYagni: executeYagniMock,
}));

vi.mock('../yagni-config.js', () => ({
  loadYagniConfig: loadYagniConfigMock,
}));

vi.mock('../yagni-gate-mode.js', () => ({
  runYagniGateMode: runYagniGateModeMock,
}));

vi.mock('../../lib/apply-advisory-exit.js', () => ({
  applyAdvisoryExitCode: applyAdvisoryExitCodeMock,
}));

function envelope(): SignalEnvelope {
  return {
    schemaVersion: 2,
    tool: 'yagni',
    runId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    verdict: {
      score: 100,
      passed: true,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
    },
    units: [],
    signals: [],
    baselineIdentity: {
      fingerprintStrategyId: 'yagni.sha256-detector-locations',
      fingerprintStrategyVersion: 1,
    },
  };
}

function mockCli(): ToolCliContext {
  return {
    emitEnvelope: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    deliverSignals: vi.fn(() => Promise.resolve()),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    renderLive: vi.fn(),
    setExitCode: vi.fn(),
    logger: console,
  } as unknown as ToolCliContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  executeYagniMock.mockResolvedValue({
    envelope: envelope(),
    session: {
      tool: 'yagni',
      cwd: '/repo',
      score: 100,
      passed: true,
      payload: { summary: { skippedDetectors: [] } },
    },
  });
  runYagniGateModeMock.mockResolvedValue({ session: { tool: 'yagni', cwd: '/repo' } });
});

describe('buildYagniCommandSpec', () => {
  it('delegates gate flags to runYagniGateMode', async () => {
    const spec = buildYagniCommandSpec(() => undefined);
    const cli = mockCli();

    await spec.handler?.({ cwd: '/repo', gateSave: true }, cli);

    expect(runYagniGateModeMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo', gateSave: true }),
      cli,
    );
    expect(executeYagniMock).not.toHaveBeenCalled();
  });

  it('emits the envelope on --json and writes SARIF when requested', async () => {
    const spec = buildYagniCommandSpec(() => undefined);
    const cli = mockCli();

    await spec.handler?.({ cwd: '/repo', json: true, sarif: 'out.sarif' }, cli);

    expect(cli.emitEnvelope).toHaveBeenCalled();
    expect(cli.writeSarif).toHaveBeenCalledWith(expect.anything(), 'out.sarif');
    expect(cli.render).not.toHaveBeenCalled();
    expect(applyAdvisoryExitCodeMock).toHaveBeenCalled();
    expect(cli.deliverSignals).toHaveBeenCalled();
  });

  it('renders a presentation on non-json, non-tty runs', async () => {
    const spec = buildYagniCommandSpec(() => undefined);
    const cli = mockCli();
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    try {
      await spec.handler?.({ cwd: '/repo', json: false }, cli);
    } finally {
      if (isTTY === undefined) Reflect.deleteProperty(process.stdout, 'isTTY');
      else Object.defineProperty(process.stdout, 'isTTY', isTTY);
    }

    expect(cli.render).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'run-presentation', tool: 'yagni' }),
    );
    expect(cli.emitEnvelope).not.toHaveBeenCalled();
  });

  it('uses renderLive on a tty when no positional paths are provided', async () => {
    const setUpLiveView = vi.fn();
    const spec = buildYagniCommandSpec(setUpLiveView);
    const cli = mockCli();
    (cli.renderLive as ReturnType<typeof vi.fn>).mockResolvedValue({
      envelope: envelope(),
      session: { tool: 'yagni', cwd: '/repo' },
    });
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    try {
      await spec.handler?.({ cwd: '/repo', json: false }, cli);
    } finally {
      if (isTTY === undefined) Reflect.deleteProperty(process.stdout, 'isTTY');
      else Object.defineProperty(process.stdout, 'isTTY', isTTY);
    }

    expect(setUpLiveView).toHaveBeenCalledWith(cli);
    expect(cli.renderLive).toHaveBeenCalled();
    expect(executeYagniMock).not.toHaveBeenCalled();
  });
});
