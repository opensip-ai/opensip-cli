/**
 * yagni-runner produce() mapping — compact vs verbose LiveRunOutcome shape.
 */

import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { HOST_VERDICT_POLICY_FALLBACK, type ToolCliContext } from '@opensip-cli/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeYagni } from '../execute-yagni.js';
import { renderYagniLive } from '../yagni-runner.js';

import type { LiveRunSpec } from '@opensip-cli/cli-live';

const runToolLiveView = vi.hoisted(() => vi.fn());

vi.mock('@opensip-cli/cli-live', () => ({
  runToolLiveView,
}));

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

function stubExecuteOutcome() {
  return {
    envelope: yagniEnvelope(),
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
  });

  it('includes verbose table and lines when --verbose is set', async () => {
    await renderYagniLive({ cwd: '/proj', verbose: true }, stubCli());
    const outcome = await capturedSpec!.produce(vi.fn(), {
      setRunning: vi.fn(),
      setHeaderMetadata: vi.fn(),
      setShowRunHeader: vi.fn(),
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.done.verboseLines?.length).toBeGreaterThan(0);
    expect(outcome.done.table?.length).toBe(1);
  });
});
