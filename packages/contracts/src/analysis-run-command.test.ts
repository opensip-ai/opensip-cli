import {
  createSignal,
  type GateCompareResult,
  type ToolCliContext,
  type ToolRunCompletion,
  type ToolSessionContribution,
} from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { defineAnalysisRunCommand } from './analysis-run-command.js';
import { REPORTING_RUN_COMMON_FLAGS } from './command-presets.js';

import type { SignalEnvelope } from './signal-envelope.js';

interface TestOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly reportTo?: string;
  readonly apiKey?: string;
  readonly open?: boolean;
  readonly sarif?: string;
  readonly filter?: readonly string[];
  readonly top?: string;
  readonly raw?: boolean;
  readonly gateSave?: boolean;
  readonly gateCompare?: boolean;
  readonly live?: boolean;
}

interface TestRequest {
  readonly cwd: string;
  readonly live: boolean;
}

interface TestResult {
  readonly envelope: SignalEnvelope;
  readonly session: ToolSessionContribution;
}

function signalEnvelope(
  signals = [
    createSignal({
      source: 'unit',
      severity: 'medium',
      ruleId: 'unit',
      message: 'finding',
      code: { file: 'src/a.ts', line: 1, column: 1 },
    }),
  ],
): SignalEnvelope {
  return {
    schemaVersion: 2,
    tool: 'test-tool',
    runId: 'run-test',
    createdAt: '2026-07-02T00:00:00.000Z',
    verdict: {
      score: signals.length === 0 ? 100 : 0,
      passed: signals.length === 0,
      summary: {
        total: 1,
        passed: signals.length === 0 ? 1 : 0,
        failed: signals.length === 0 ? 0 : 1,
        errors: 0,
        warnings: signals.length,
      },
    },
    units: [
      {
        slug: 'unit',
        passed: signals.length === 0,
        violationCount: signals.length,
        durationMs: 1,
      },
    ],
    signals,
    baselineIdentity: {
      fingerprintStrategyId: 'test.strategy',
      fingerprintStrategyVersion: 1,
    },
  };
}

function testResult(envelope = signalEnvelope()): TestResult {
  return {
    envelope,
    session: {
      tool: 'fit',
      cwd: '/repo',
      score: envelope.verdict.score,
      passed: envelope.verdict.passed,
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

function makeCli(compare = compareResult(false)): ToolCliContext & {
  readonly _calls: {
    readonly emitEnvelope: ReturnType<typeof vi.fn>;
    readonly emitJson: ReturnType<typeof vi.fn>;
    readonly emitRaw: ReturnType<typeof vi.fn>;
    readonly render: ReturnType<typeof vi.fn>;
    readonly renderLive: ReturnType<typeof vi.fn>;
    readonly deliverSignals: ReturnType<typeof vi.fn>;
    readonly maybeOpenReport: ReturnType<typeof vi.fn>;
    readonly writeSarif: ReturnType<typeof vi.fn>;
    readonly saveBaseline: ReturnType<typeof vi.fn>;
    readonly compareBaseline: ReturnType<typeof vi.fn>;
    readonly reportFailure: ReturnType<typeof vi.fn>;
  };
} {
  const calls = {
    emitEnvelope: vi.fn(),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    renderLive: vi.fn(() => Promise.resolve<ToolRunCompletion>({})),
    deliverSignals: vi.fn(() => Promise.resolve({ delivered: false })),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    saveBaseline: vi.fn(() => Promise.resolve()),
    compareBaseline: vi.fn(() => Promise.resolve(compare)),
    reportFailure: vi.fn(() => Promise.resolve()),
  };
  return {
    scope: { toolConfig: {}, datastore: () => undefined },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: vi.fn(),
    getExitCode: vi.fn(),
    emitEnvelope: calls.emitEnvelope,
    emitJson: calls.emitJson,
    emitRaw: calls.emitRaw,
    render: calls.render,
    renderLive: calls.renderLive,
    deliverSignals: calls.deliverSignals,
    maybeOpenReport: calls.maybeOpenReport,
    writeSarif: calls.writeSarif,
    saveBaseline: calls.saveBaseline,
    compareBaseline: calls.compareBaseline,
    reportFailure: calls.reportFailure,
    _calls: calls,
  } as unknown as ToolCliContext & { readonly _calls: typeof calls };
}

function command() {
  return defineAnalysisRunCommand<TestOptions, TestRequest, TestResult>({
    description: 'Run test analysis',
    options: [{ flag: '--sample', description: 'Sample option', default: false }],
    args: [{ name: 'paths', description: 'Paths', optional: true, variadic: true }],
    normalize: (options) => ({ cwd: options.cwd, live: options.live === true }),
    execute: (request) => testResult(signalEnvelope(request.cwd === '/clean' ? [] : undefined)),
    envelope: (result) => result.envelope,
    session: (result) => result.session,
    presentation: ({ durationMs }) => ({ type: 'text-lines', lines: [`done ${durationMs}`] }),
    live: {
      key: 'test-live',
      shouldUse: ({ request }) => request.live,
      args: ({ request }) => ({ cwd: request.cwd }),
    },
    gate: {
      tool: 'fitness',
      mode: ({ options }) => {
        if (options.gateSave === true) return 'save';
        if (options.gateCompare === true) return 'compare';
        return undefined;
      },
      renderSaveLines: ({ envelope }) => [`saved ${String(envelope.signals.length)}`],
      renderCompareLines: ({ result }) => [`degraded ${String(result.degraded)}`],
    },
  });
}

describe('defineAnalysisRunCommand', () => {
  it('preserves primary run command preset fields and routes static human runs', async () => {
    const spec = command();
    expect(spec).toMatchObject({
      description: 'Run test analysis',
      commonFlags: REPORTING_RUN_COMMON_FLAGS,
      output: 'raw-stream',
      rawStreamReason: 'runtime-render-dispatch',
      producesVerdict: true,
    });

    const cli = makeCli();
    const completion = (await spec.handler({ cwd: '/repo' }, cli)) as ToolRunCompletion;

    expect(cli._calls.render).toHaveBeenCalledWith({
      type: 'text-lines',
      lines: [expect.stringMatching(/^done \d+$/)],
    });
    expect(cli._calls.deliverSignals).toHaveBeenCalledOnce();
    expect(cli._calls.maybeOpenReport).toHaveBeenCalledWith({
      openRequested: false,
      jsonOutput: false,
    });
    expect(completion.session).toMatchObject({ tool: 'fit', cwd: '/repo' });
  });

  it('uses shared agent JSON filtering for JSON output', async () => {
    const cli = makeCli();

    await command().handler(
      {
        cwd: '/repo',
        json: true,
        raw: true,
        filter: ['source:unit'],
        top: '1',
      },
      cli,
    );

    expect(cli._calls.emitEnvelope).not.toHaveBeenCalled();
    expect(cli._calls.emitRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent-filtered',
        filtersApplied: ['source:unit', 'top:1'],
        returnedSignalCount: 1,
      }),
    );
  });

  it('routes live completion through the same delivery and session tail', async () => {
    const envelope = signalEnvelope();
    const session = testResult(envelope).session;
    const cli = makeCli();
    cli._calls.renderLive.mockResolvedValue({ envelope, session });

    const completion = (await command().handler(
      { cwd: '/repo', live: true },
      cli,
    )) as ToolRunCompletion;

    expect(cli._calls.renderLive).toHaveBeenCalledWith('test-live', { cwd: '/repo' });
    expect(cli._calls.deliverSignals).toHaveBeenCalledWith(envelope, { cwd: '/repo' });
    expect(completion.session).toBe(session);
  });

  it('dispatches gate save/compare through the shared host gate helper', async () => {
    const saveCli = makeCli();
    await command().handler({ cwd: '/repo', gateSave: true, sarif: 'out.sarif' }, saveCli);
    expect(saveCli._calls.saveBaseline).toHaveBeenCalledWith(
      'fitness',
      expect.objectContaining({ tool: 'test-tool' }),
    );
    expect(saveCli._calls.writeSarif).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'test-tool' }),
      'out.sarif',
    );

    const compareCli = makeCli(compareResult(true));
    await command().handler({ cwd: '/repo', gateCompare: true }, compareCli);
    expect(compareCli._calls.compareBaseline).toHaveBeenCalledWith(
      'fitness',
      expect.objectContaining({ tool: 'test-tool' }),
    );
    expect(compareCli._calls.deliverSignals).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'test-tool' }),
      { cwd: '/repo', runFailed: true },
    );
  });

  it('reports mutually exclusive gate flags before execution', async () => {
    const cli = makeCli();
    await command().handler({ cwd: '/repo', gateSave: true, gateCompare: true, json: true }, cli);

    expect(cli._calls.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('mutually exclusive'),
        jsonRequested: true,
      }),
    );
    expect(cli._calls.deliverSignals).not.toHaveBeenCalled();
  });

  it('writes SARIF only when requested on non-gate runs', async () => {
    const cli = makeCli();
    await command().handler({ cwd: '/repo', sarif: 'analysis.sarif', reportTo: 'https://r' }, cli);

    expect(cli._calls.deliverSignals).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'test-tool' }),
      { cwd: '/repo', reportTo: 'https://r' },
    );
    expect(cli._calls.writeSarif).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'test-tool' }),
      'analysis.sarif',
    );
  });

  it('returns empty live completions without delivery when no envelope is emitted', async () => {
    const cli = makeCli();
    cli._calls.renderLive.mockResolvedValue({});

    const completion = (await command().handler(
      { cwd: '/repo', live: true },
      cli,
    )) as ToolRunCompletion;

    expect(completion).toEqual({});
    expect(cli._calls.deliverSignals).not.toHaveBeenCalled();
  });

  it('runs static hooks, passes delivery options, and skips render when no presentation exists', async () => {
    const events: string[] = [];
    const spec = defineAnalysisRunCommand<TestOptions, TestRequest, TestResult>({
      description: 'Run headless analysis',
      normalize: (options) => ({ cwd: options.cwd, live: false }),
      execute: () => testResult(),
      envelope: (result) => result.envelope,
      beforeOutput: () => {
        events.push('before');
      },
      afterDelivery: () => {
        events.push('after');
      },
    });
    const cli = makeCli();

    const completion = await spec.handler(
      { cwd: '/repo', apiKey: 'sk-test', open: true, reportTo: 'https://reports.test' },
      cli,
    );

    expect(completion).toEqual({});
    expect(events).toEqual(['before', 'after']);
    expect(cli._calls.render).not.toHaveBeenCalled();
    expect(cli._calls.deliverSignals).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'test-tool' }),
      {
        cwd: '/repo',
        reportTo: 'https://reports.test',
        apiKey: 'sk-test',
      },
    );
    expect(cli._calls.maybeOpenReport).toHaveBeenCalledWith({
      openRequested: true,
      jsonOutput: false,
    });
  });

  it('surfaces delivery failures after emitting the failure lifecycle path', async () => {
    const cli = makeCli();
    cli._calls.deliverSignals.mockRejectedValue(new Error('egress down'));

    await expect(command().handler({ cwd: '/repo' }, cli)).rejects.toThrow('egress down');
    expect(cli._calls.writeSarif).not.toHaveBeenCalled();
  });

  it('lets live adapters add a session contribution after host delivery', async () => {
    const envelope = signalEnvelope();
    const spec = defineAnalysisRunCommand<TestOptions, TestRequest, TestResult>({
      description: 'Run live analysis',
      normalize: (options) => ({ cwd: options.cwd, live: true }),
      execute: () => testResult(envelope),
      envelope: (result) => result.envelope,
      live: {
        key: 'test-live',
        shouldUse: () => true,
        args: ({ request }) => ({ cwd: request.cwd }),
        session: ({ envelope: completedEnvelope }) => ({
          tool: 'graph',
          cwd: '/repo',
          score: completedEnvelope.verdict.score,
          passed: completedEnvelope.verdict.passed,
        }),
      },
    });
    const cli = makeCli();
    cli._calls.renderLive.mockResolvedValue({ envelope });

    const completion = (await spec.handler({ cwd: '/repo', live: true }, cli)) as ToolRunCompletion;

    expect(completion.session).toMatchObject({ tool: 'graph', cwd: '/repo' });
    expect(cli._calls.deliverSignals).toHaveBeenCalledWith(envelope, { cwd: '/repo' });
  });
});
