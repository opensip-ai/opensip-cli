import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeYagniWorker, yagniRunWorkerCommandSpec } from '../yagni-worker.js';

import type { ExecuteYagniOptions } from '../execute-yagni.js';
import type * as CoreModule from '@opensip-cli/core';
import type { ToolCliContext } from '@opensip-cli/core';

const executeYagniMock = vi.hoisted(() => vi.fn());
const loadYagniConfigMock = vi.hoisted(() =>
  vi.fn(() => ({
    defaultMinConfidence: 'low' as const,
    disabledDetectors: [],
  })),
);
const sendWorkerIpcMessageMock = vi.hoisted(() => vi.fn());
const stopHeartbeatMock = vi.hoisted(() => vi.fn());
const startWorkerHeartbeatMock = vi.hoisted(() => vi.fn(() => stopHeartbeatMock));

vi.mock('@opensip-cli/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    sendWorkerIpcMessage: sendWorkerIpcMessageMock,
    startWorkerHeartbeat: startWorkerHeartbeatMock,
  };
});

vi.mock('../execute-yagni.js', () => ({
  executeYagni: executeYagniMock,
}));

vi.mock('../yagni-config.js', () => ({
  loadYagniConfig: loadYagniConfigMock,
}));

function stubCli(): ToolCliContext {
  return {
    deliverSignals: vi.fn(() => Promise.resolve({ delivered: false })),
    reportFailure: vi.fn(() => Promise.resolve()),
  } as unknown as ToolCliContext;
}

function writeSpec(value: unknown): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'yagni-worker-test-'));
  const path = join(dir, 'spec.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return { dir, path };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('yagni worker command', () => {
  it('streams detector progress and the final result from a JSON spec', async () => {
    const { dir, path } = writeSpec({
      cwd: '/repo',
      minConfidence: 'high',
      detectors: ['yagni:unused-config-surface'],
      categories: ['configuration'],
      includeTests: true,
      pathRoots: ['src'],
    });
    const cli = stubCli();
    const result = {
      envelope: { tool: 'yagni', runId: 'run-1' },
      session: { tool: 'yagni', cwd: '/repo' },
    };
    executeYagniMock.mockImplementation((options: ExecuteYagniOptions) => {
      options.onDetectorStart?.('yagni:unused-config-surface');
      options.onDetectorDone?.('yagni:unused-config-surface', 42);
      options.onDetectorsSkipped?.(['yagni:disabled-stub']);
      return result;
    });

    try {
      await yagniRunWorkerCommandSpec.handler?.({ _args: [path] }, cli);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(startWorkerHeartbeatMock).toHaveBeenCalledTimes(1);
    expect(stopHeartbeatMock).toHaveBeenCalledTimes(1);
    expect(loadYagniConfigMock).toHaveBeenCalledWith('/repo');
    expect(executeYagniMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo',
        config: { defaultMinConfidence: 'low', disabledDetectors: [] },
        minConfidence: 'high',
        detectors: ['yagni:unused-config-surface'],
        categories: ['configuration'],
        includeTests: true,
        pathRoots: ['src'],
      }),
      cli,
    );
    expect(sendWorkerIpcMessageMock).toHaveBeenNthCalledWith(1, {
      kind: 'progress',
      event: {
        type: 'stage-start',
        stage: 'yagni:unused-config-surface',
        label: 'Unused Config Surface',
      },
    });
    expect(sendWorkerIpcMessageMock).toHaveBeenNthCalledWith(2, {
      kind: 'progress',
      event: { type: 'stage-done', stage: 'yagni:unused-config-surface', durationMs: 42 },
    });
    expect(sendWorkerIpcMessageMock).toHaveBeenNthCalledWith(3, {
      kind: 'progress',
      event: {
        type: 'stage-done',
        stage: 'yagni:disabled-stub',
        durationMs: 0,
        detail: 'skipped',
      },
    });
    expect(sendWorkerIpcMessageMock).toHaveBeenNthCalledWith(4, {
      kind: 'result',
      value: result,
    });
  });

  it('sends structured worker errors and stops the heartbeat when execution fails', async () => {
    const { dir, path } = writeSpec({ cwd: '/repo' });
    const error = Object.assign(new Error('detector failed'), {
      failureClass: 'configuration',
    });
    executeYagniMock.mockRejectedValue(error);

    try {
      await executeYagniWorker(path, stubCli());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(sendWorkerIpcMessageMock).toHaveBeenCalledWith({
      kind: 'error',
      message: 'detector failed',
      stack: expect.stringContaining('detector failed'),
      failureClass: 'configuration',
    });
    expect(stopHeartbeatMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes non-Error worker failures', async () => {
    const { dir, path } = writeSpec({ cwd: '/repo' });
    executeYagniMock.mockRejectedValue('plain failure');

    try {
      await executeYagniWorker(path, stubCli());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(sendWorkerIpcMessageMock).toHaveBeenCalledWith({
      kind: 'error',
      message: 'plain failure',
    });
    expect(stopHeartbeatMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a worker error when the internal handler has no spec path', async () => {
    await yagniRunWorkerCommandSpec.handler?.({}, stubCli());

    expect(sendWorkerIpcMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error' }),
    );
    expect(executeYagniMock).not.toHaveBeenCalled();
    expect(stopHeartbeatMock).toHaveBeenCalledTimes(1);
  });
});
