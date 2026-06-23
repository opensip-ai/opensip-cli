/**
 * graph-runner produce() mapping — summary, verbose lines/table gates.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderGraphLive } from '../graph-runner.js';

import type { LiveGraphOutput } from '../graph-report.js';
import type { LiveRunSpec } from '@opensip-cli/cli-live';
import type * as CoreModule from '@opensip-cli/core';
import type { Signal } from '@opensip-cli/core';

const runToolLiveView = vi.hoisted(() => vi.fn());
const runOffThreadOrInProcess = vi.hoisted(() => vi.fn());

vi.mock('@opensip-cli/cli-live', () => ({
  runToolLiveView,
}));

vi.mock('@opensip-cli/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    runOffThreadOrInProcess,
    currentScope: vi.fn(() => ({ runId: 'RUN_graph_test' })),
  };
});

function liveGraphOutput(): LiveGraphOutput {
  const signals: Signal[] = [
    {
      id: 'sig_cycle',
      source: 'graph:cycle',
      provider: 'opensip-cli',
      severity: 'high',
      category: 'architecture',
      ruleId: 'graph:cycle',
      message: 'cycle detected',
      filePath: 'src/a.ts',
      line: 1,
      metadata: {},
      createdAt: '2026-06-04T00:00:00.000Z',
    },
  ];
  return {
    signals,
    suppressedCount: 0,
    reportLines: ['Graph catalog line'],
    resolutionMode: 'fast',
  };
}

let capturedSpec: LiveRunSpec | undefined;

beforeEach(() => {
  capturedSpec = undefined;
  runToolLiveView.mockReset();
  runOffThreadOrInProcess.mockReset();
  runOffThreadOrInProcess.mockImplementation(({ inProcess }) => ({
    onProgress: vi.fn(),
    result: Promise.resolve(inProcess(vi.fn())),
  }));
  runToolLiveView.mockImplementation((spec: LiveRunSpec) => {
    capturedSpec = spec;
    return Promise.resolve({});
  });
});

describe('renderGraphLive produce mapping', () => {
  it('routes through runToolLiveView with the graph tool key', async () => {
    await renderGraphLive({ cwd: '/proj' });
    expect(runToolLiveView).toHaveBeenCalledTimes(1);
    expect(capturedSpec?.tool).toBe('graph');
  });

  it('omits verbose lines and table on compact runs', async () => {
    runOffThreadOrInProcess.mockImplementation(() => ({
      onProgress: vi.fn(),
      result: Promise.resolve(liveGraphOutput()),
    }));
    await renderGraphLive({ cwd: '/proj', verbose: false });
    const outcome = await capturedSpec!.produce(vi.fn(), {
      setRunning: vi.fn(),
      setHeaderMetadata: vi.fn(),
      setShowRunHeader: vi.fn(),
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.done.verboseLines).toBeUndefined();
    expect(outcome.done.table).toBeUndefined();
    expect(outcome.done.summary).toMatchObject({ passed: false, errors: 1, warnings: 0 });
    expect(outcome.session?.tool).toBe('graph');
  });

  it('includes verbose lines and the per-rule table when --verbose', async () => {
    runOffThreadOrInProcess.mockImplementation(() => ({
      onProgress: vi.fn(),
      result: Promise.resolve(liveGraphOutput()),
    }));
    await renderGraphLive({ cwd: '/proj', verbose: true });
    const outcome = await capturedSpec!.produce(vi.fn(), {
      setRunning: vi.fn(),
      setHeaderMetadata: vi.fn(),
      setShowRunHeader: vi.fn(),
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.done.verboseLines).toEqual(['Graph catalog line']);
    expect(outcome.done.table?.length).toBeGreaterThan(0);
    expect(String(outcome.done.banner)).toMatch(/fast/i);
  });
});
