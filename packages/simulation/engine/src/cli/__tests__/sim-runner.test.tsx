/**
 * @fileoverview Tests for the sim live-view entry (cli-live shell).
 */

import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { HOST_VERDICT_POLICY_FALLBACK } from '@opensip-cli/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSimLive } from '../sim-runner.js';
import { executeSim } from '../sim.js';

import type { LiveRunSpec } from '@opensip-cli/cli-live';
import type * as CoreModule from '@opensip-cli/core';

const runToolLiveView = vi.hoisted(() => vi.fn());
const runOffThreadOrInProcess = vi.hoisted(() => vi.fn());

vi.mock('@opensip-cli/cli-live', () => ({
  runToolLiveView,
}));

vi.mock('../sim.js', () => ({
  executeSim: vi.fn(),
}));

vi.mock('@opensip-cli/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    runOffThreadOrInProcess,
    currentScope: vi.fn(() => undefined),
  };
});

const executeSimMock = executeSim as unknown as ReturnType<typeof vi.fn>;

function simEnvelope() {
  return buildSignalEnvelope({
    tool: 'sim',
    runId: 'run-sim',
    createdAt: '2026-06-04T00:00:00.000Z',
    recipe: 'example',
    units: [{ slug: 'scenario-a', passed: true, durationMs: 8 }],
    signals: [],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

let capturedSpec: LiveRunSpec | undefined;

beforeEach(() => {
  capturedSpec = undefined;
  runToolLiveView.mockReset();
  runOffThreadOrInProcess.mockReset();
  executeSimMock.mockReset();
  executeSimMock.mockResolvedValue({
    result: {
      type: 'run-presentation',
      tool: 'simulation',
      envelope: simEnvelope(),
    },
  });
  runOffThreadOrInProcess.mockImplementation(({ inProcess }) => ({
    onProgress: vi.fn(),
    result: Promise.resolve(inProcess(vi.fn())),
  }));
  runToolLiveView.mockImplementation((spec: LiveRunSpec) => {
    capturedSpec = spec;
    return Promise.resolve({});
  });
});

describe('renderSimLive', () => {
  it('routes through runToolLiveView with the sim tool key', async () => {
    await renderSimLive({ cwd: '/proj', recipe: 'example', json: false, debug: false });
    expect(runToolLiveView).toHaveBeenCalledTimes(1);
    expect(capturedSpec?.tool).toBe('sim');
  });

  it('maps executeSim results into a done LiveRunOutcome with session', async () => {
    await renderSimLive({ cwd: '/proj', recipe: 'example', json: false, debug: false });
    const outcome = await capturedSpec!.produce(vi.fn(), {
      setRunning: vi.fn(),
      setHeaderMetadata: vi.fn(),
      setShowRunHeader: vi.fn(),
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.done.summary).toMatchObject({ passed: true, errors: 0, warnings: 0 });
    expect(outcome.session).toMatchObject({ tool: 'sim', cwd: '/proj', passed: true });
    expect(outcome.envelope?.recipe).toBe('example');
  });
});
