/**
 * fit-runner produce() mapping — summary, verbose table gate, session shape.
 */

import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { HOST_VERDICT_POLICY_FALLBACK } from '@opensip-cli/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderFitLive } from '../fit-runner.js';
import { ensureChecksLoaded, executeFit, getEnabledCheckCount } from '../fit.js';

import type { LiveRunSpec } from '@opensip-cli/cli-live';
import type { FitOptions } from '@opensip-cli/contracts';
import type * as CoreModule from '@opensip-cli/core';

function fitArgs(over: Partial<FitOptions> & Pick<FitOptions, 'cwd'>): FitOptions {
  return {
    list: false,
    recipes: false,
    json: false,
    verbose: false,
    exclude: [],
    debug: false,
    ...over,
  };
}

const runToolLiveView = vi.hoisted(() => vi.fn());
const runOffThreadOrInProcess = vi.hoisted(() => vi.fn());

vi.mock('@opensip-cli/cli-live', () => ({
  runToolLiveView,
}));

vi.mock('../fit.js', () => ({
  ensureChecksLoaded: vi.fn().mockResolvedValue(undefined),
  getEnabledCheckCount: vi.fn(() => 3),
  executeFit: vi.fn(),
}));

vi.mock('../fit/envelope-view.js', () => ({
  buildFitVerboseDetail: vi.fn(() => undefined),
  envelopeToFitRows: vi.fn(() => [
    {
      check: 'Dead Code',
      status: 'FAIL',
      errors: 1,
      warnings: 0,
      validated: 4,
      itemType: 'files',
      ignored: 0,
      durationMs: 50,
    },
  ]),
}));

vi.mock('@opensip-cli/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    runOffThreadOrInProcess,
    currentScope: vi.fn(() => undefined),
  };
});

const ensureChecksLoadedMock = ensureChecksLoaded as unknown as ReturnType<typeof vi.fn>;
const executeFitMock = executeFit as unknown as ReturnType<typeof vi.fn>;
const getEnabledCheckCountMock = getEnabledCheckCount as unknown as ReturnType<typeof vi.fn>;

function fitEnvelope() {
  return buildSignalEnvelope({
    tool: 'fit',
    runId: 'run-fit',
    createdAt: '2026-06-04T00:00:00.000Z',
    recipe: 'default',
    units: [
      {
        slug: 'dead-code',
        passed: false,
        violationCount: 1,
        durationMs: 50,
        filesValidated: 4,
        itemType: 'files',
        ignoredCount: 0,
      },
    ],
    signals: [],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

let capturedSpec: LiveRunSpec | undefined;

async function invokeProduce() {
  return capturedSpec!.produce(vi.fn(), {
    setRunning: vi.fn(),
    setHeaderMetadata: vi.fn(),
    setShowRunHeader: vi.fn(),
  });
}

beforeEach(() => {
  capturedSpec = undefined;
  runToolLiveView.mockReset();
  runOffThreadOrInProcess.mockReset();
  ensureChecksLoadedMock.mockClear();
  executeFitMock.mockReset();
  getEnabledCheckCountMock.mockReturnValue(3);

  const envelope = fitEnvelope();
  executeFitMock.mockResolvedValue({
    result: { type: 'run-presentation', tool: 'fitness', envelope },
    warnings: [],
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

describe('renderFitLive produce mapping', () => {
  it('routes through runToolLiveView with the fit tool key', async () => {
    await renderFitLive(fitArgs({ cwd: '/proj' }));
    expect(runToolLiveView).toHaveBeenCalledTimes(1);
    expect(capturedSpec?.tool).toBe('fitness');
  });

  it('omits the per-check table unless --verbose', async () => {
    await renderFitLive(fitArgs({ cwd: '/proj', verbose: false }));
    const outcome = await invokeProduce();
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.done.table).toBeUndefined();
    expect(outcome.done.summary).toMatchObject({ passed: true, errors: 0, warnings: 0 });
    expect(outcome.session).toMatchObject({ tool: 'fit', cwd: '/proj', passed: true });
  });

  it('includes the validated-column table when --verbose', async () => {
    await renderFitLive(fitArgs({ cwd: '/proj', verbose: true }));
    const outcome = await invokeProduce();
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.done.table?.[0]).toMatchObject({
      unit: expect.any(String),
      status: 'FAIL',
      validated: 4,
      ignored: 0,
    });
  });
});
