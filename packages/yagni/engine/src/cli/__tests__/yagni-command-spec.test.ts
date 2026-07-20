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
const applyAdvisoryExitCodeMock = vi.hoisted(() => vi.fn());

vi.mock('../execute-yagni.js', () => ({
  executeYagni: executeYagniMock,
}));

vi.mock('../yagni-config.js', () => ({
  loadYagniConfig: loadYagniConfigMock,
  readYagniConfig: loadYagniConfigMock,
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
    // `scope` is a REQUIRED ToolCliContext member — the typed lifecycle seam
    // (plan 09 Task 8.5) no longer tolerates a context without one.
    scope: { datastore: () => undefined },
    emitEnvelope: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    saveBaseline: vi.fn(() => Promise.resolve()),
    compareBaseline: vi.fn(() =>
      Promise.resolve({ added: [], resolved: [], unchanged: [], degraded: false }),
    ),
    reportFailure: vi.fn(() => Promise.resolve()),
    renderLive: vi.fn(),
    setExitCode: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
});

describe('buildYagniCommandSpec', () => {
  it('keeps report-producing primary run flags on the migrated command', () => {
    const spec = buildYagniCommandSpec(() => undefined);

    expect(spec.commonFlags).toContain('open');
  });

  it('leaves --include-tests unset so the resolved config can supply its default', () => {
    const spec = buildYagniCommandSpec(() => undefined);
    const includeTests = spec.options?.find((option) => option.flag === '--include-tests');

    expect(includeTests).toBeDefined();
    expect(includeTests).not.toHaveProperty('default');
  });

  it('routes gate flags through the host gate dispatch path', async () => {
    const spec = buildYagniCommandSpec(() => undefined);
    const cli = mockCli();

    await spec.handler?.({ cwd: '/repo', gateSave: true, sarif: 'yagni.sarif' }, cli);

    expect(executeYagniMock).toHaveBeenCalled();
    expect(cli.saveBaseline).toHaveBeenCalledWith(
      'yagni',
      expect.objectContaining({ tool: 'yagni' }),
    );
    expect(cli.deliverSignals).toHaveBeenCalled();
    expect(cli.writeSarif).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'yagni' }),
      'yagni.sarif',
    );
  });

  it('fails gate compare delivery when the baseline degraded', async () => {
    const spec = buildYagniCommandSpec(() => undefined);
    const cli = mockCli();
    (cli.compareBaseline as ReturnType<typeof vi.fn>).mockResolvedValue({
      degraded: true,
      added: [1],
      resolved: [],
      unchanged: [],
    });

    await spec.handler?.({ cwd: '/repo', gateCompare: true }, cli);

    expect(cli.compareBaseline).toHaveBeenCalledWith(
      'yagni',
      expect.objectContaining({ tool: 'yagni' }),
    );
    expect(cli.deliverSignals).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'yagni' }),
      expect.objectContaining({ runFailed: true }),
    );
    expect(cli.render).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gate-done',
        lines: ['YAGNI gate FAILED: 1 new finding(s) since baseline.'],
      }),
    );
    // The advisory-exit reaffirmation must NOT run on the gate path — the host
    // owns the gate exit (ADR-0035); running it would reset the RUNTIME_ERROR
    // the degraded compare set back to SUCCESS (silent ratchet bypass).
    expect(applyAdvisoryExitCodeMock).not.toHaveBeenCalled();
  });

  it('reports mutually exclusive gate flags before execution', async () => {
    const spec = buildYagniCommandSpec(() => undefined);
    const cli = mockCli();

    await spec.handler?.({ cwd: '/repo', gateSave: true, gateCompare: true, json: true }, cli);

    expect(cli.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('mutually exclusive'),
        jsonRequested: true,
      }),
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
