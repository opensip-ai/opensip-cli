/**
 * yagni-runner produce() mapping — compact vs verbose LiveRunOutcome shape.
 */

import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { createSignal, HOST_VERDICT_POLICY_FALLBACK, type ToolCliContext } from '@opensip-cli/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeYagni, type ExecuteYagniOptions } from '../execute-yagni.js';
import { renderYagniLive } from '../yagni-runner.js';

import type { LiveRunSpec } from '@opensip-cli/cli-live';
import type * as CoreModule from '@opensip-cli/core';

const runToolLiveView = vi.hoisted(() => vi.fn());
const runOffThreadOrInProcess = vi.hoisted(() =>
  vi.fn((opts: { inProcess: (emit: (event: unknown) => void) => Promise<unknown> }) => ({
    onProgress: vi.fn(),
    result: opts.inProcess(vi.fn()),
  })),
);

vi.mock('@opensip-cli/cli-live', () => ({
  runToolLiveView,
}));

vi.mock('@opensip-cli/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    liveEngineCorrelation: vi.fn(() => undefined),
    runOffThreadOrInProcess,
  };
});

vi.mock('../yagni-config.js', () => ({
  loadYagniConfig: vi.fn(() => ({})),
}));

vi.mock('../execute-yagni.js', () => ({
  executeYagni: vi.fn(),
}));

const executeYagniMock = executeYagni as unknown as ReturnType<typeof vi.fn>;

function stubCli(): ToolCliContext {
  return {
    scope: { datastore: () => undefined },
    deliverSignals: vi.fn(() => Promise.resolve({ delivered: false })),
    reportFailure: vi.fn(() => Promise.resolve()),
  } as unknown as ToolCliContext;
}

function yagniEnvelope(): ReturnType<typeof buildSignalEnvelope> {
  return buildSignalEnvelope({
    tool: 'yagni',
    runId: 'run-yagni',
    createdAt: '2026-06-04T00:00:00.000Z',
    units: [{ slug: 'yagni:unused-config-surface', passed: false, durationMs: 12 }],
    signals: [],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

function yagniEnvelopeWithSignals(): ReturnType<typeof buildSignalEnvelope> {
  return buildSignalEnvelope({
    tool: 'yagni',
    runId: 'run-yagni-signals',
    createdAt: '2026-06-04T00:00:00.000Z',
    units: [
      { slug: 'yagni:unused-config-surface', passed: false, durationMs: 12 },
      { slug: 'yagni:passing-detector', passed: true, durationMs: 4 },
      { slug: 'yagni:errored-detector', passed: false, durationMs: 2, error: 'boom' },
    ],
    signals: [
      createSignal({
        source: 'yagni:unused-config-surface',
        severity: 'high',
        ruleId: 'yagni:unused-config-surface',
        message: 'Remove speculative config.',
        code: { file: 'src/a.ts', line: 1 },
      }),
      createSignal({
        source: 'yagni:unused-config-surface',
        severity: 'medium',
        ruleId: 'yagni:unused-config-surface',
        message: 'Review speculative config.',
        code: { file: 'src/b.ts', line: 2 },
      }),
    ],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

function stubExecuteOutcome(envelope = yagniEnvelope()) {
  return {
    envelope,
    session: {
      tool: 'yagni' as const,
      cwd: '/proj',
      score: 80,
      passed: false,
      payload: {
        __version: 1 as const,
        summary: {
          total: 1,
          passed: 0,
          failed: 1,
          errors: 0,
          warnings: 1,
          skippedDetectors: [],
          yagni: {
            totalCandidates: 1,
            byConfidence: { high: 1, medium: 0, low: 0 },
            estimatedTotalLocReduction: 10,
            skippedDetectors: [],
          },
        },
        checks: [],
      },
    },
  };
}

let capturedSpec: LiveRunSpec | undefined;
let capturedGlue: unknown;

beforeEach(() => {
  capturedSpec = undefined;
  capturedGlue = undefined;
  runToolLiveView.mockReset();
  runOffThreadOrInProcess.mockClear();
  executeYagniMock.mockReset();
  executeYagniMock.mockResolvedValue(stubExecuteOutcome());
  runToolLiveView.mockImplementation((spec: LiveRunSpec, glue: unknown) => {
    capturedSpec = spec;
    capturedGlue = glue;
    return Promise.resolve({});
  });
});

describe('renderYagniLive produce mapping', () => {
  it('routes through runToolLiveView with the yagni tool key', async () => {
    await renderYagniLive({ cwd: '/proj' }, stubCli());
    expect(runToolLiveView).toHaveBeenCalledTimes(1);
    expect(capturedSpec?.tool).toBe('yagni');
  });

  it('passes the host exit-code hook to runToolLiveView', async () => {
    const setExitCode = vi.fn();
    await renderYagniLive(
      { cwd: '/proj' },
      {
        ...stubCli(),
        setExitCode,
      },
    );
    expect(capturedGlue).toMatchObject({ setExitCode });
  });

  it('omits verbose table and lines on compact runs', async () => {
    await renderYagniLive({ cwd: '/proj', verbose: false }, stubCli());
    const outcome = await capturedSpec!.produce(vi.fn(), {
      setRunning: vi.fn(),
      setHeaderMetadata: vi.fn(),
      setShowRunHeader: vi.fn(),
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.done.verboseLines).toBeUndefined();
    expect(outcome.done.table).toBeUndefined();
    expect(outcome.done.summary).toMatchObject({
      passed: true,
      errors: 0,
      warnings: 0,
    });
    expect(outcome.session?.tool).toBe('yagni');
    expect(outcome.session?.passed).toBe(false);
    expect(runOffThreadOrInProcess).toHaveBeenCalled();
  });

  it('includes verbose table and lines when --verbose is set', async () => {
    executeYagniMock.mockImplementation((options: ExecuteYagniOptions) => {
      options.onDetectorStart?.('yagni:unused-config-surface');
      options.onDetectorDone?.('yagni:unused-config-surface', 12);
      options.onDetectorsSkipped?.(['yagni:disabled-stub']);
      return stubExecuteOutcome(yagniEnvelopeWithSignals());
    });

    await renderYagniLive({ cwd: '/proj', verbose: true }, stubCli());
    const outcome = await capturedSpec!.produce(vi.fn(), {
      setRunning: vi.fn(),
      setHeaderMetadata: vi.fn(),
      setShowRunHeader: vi.fn(),
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.done.verboseLines?.length).toBeGreaterThan(0);
    expect(outcome.done.summary).toMatchObject({ passed: false, errors: 1, warnings: 1 });
    expect(outcome.done.table).toEqual([
      {
        unit: 'yagni:unused-config-surface',
        status: 'FAIL',
        errors: 1,
        warnings: 1,
        durationMs: 12,
      },
      {
        unit: 'yagni:passing-detector',
        status: 'PASS',
        errors: 0,
        warnings: 0,
        durationMs: 4,
      },
      {
        unit: 'yagni:errored-detector',
        status: 'ERROR',
        errors: 0,
        warnings: 0,
        durationMs: 2,
      },
    ]);
  });
});
