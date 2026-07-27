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
const runJsonSpecWorkerMock = vi.hoisted(() => vi.fn());
const SPEC_PATH = join(process.cwd(), '.runtime', 'yagni-spec.test.json');
const COMMAND_SPEC_PATH = join(process.cwd(), '.runtime', 'yagni-command-spec.test.json');

vi.mock('@opensip-cli/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    runJsonSpecWorker: runJsonSpecWorkerMock,
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

beforeEach(() => {
  vi.clearAllMocks();
  runJsonSpecWorkerMock.mockResolvedValue(undefined);
});

describe('yagni worker command', () => {
  it('delegates terminal IPC, failure projection, heartbeat, and cancellation to the JSON worker', async () => {
    await executeYagniWorker(SPEC_PATH, stubCli());

    expect(runJsonSpecWorkerMock).toHaveBeenCalledTimes(1);
    expect(runJsonSpecWorkerMock).toHaveBeenCalledWith({
      specPath: SPEC_PATH,
      run: expect.any(Function),
    });
  });

  it('maps a parsed worker spec and detector lifecycle events into the executor', async () => {
    const result = {
      envelope: { tool: 'yagni', runId: 'run-1' },
      session: { tool: 'yagni', cwd: '/repo' },
    };
    executeYagniMock.mockImplementation((options: ExecuteYagniOptions) => {
      options.onDetectorStart?.('yagni:unused-config-surface');
      options.onDetectorDone?.('yagni:unused-config-surface', 42);
      options.onDetectorsSkipped?.(['yagni:disabled-stub']);
      return Promise.resolve(result);
    });
    await executeYagniWorker(SPEC_PATH, stubCli());
    const worker = runJsonSpecWorkerMock.mock.calls[0]?.[0] as {
      run: (args: Record<string, unknown>, emit: (event: unknown) => void) => Promise<unknown>;
    };
    const emit = vi.fn();

    await expect(
      worker.run(
        {
          cwd: '/repo',
          minConfidence: 'high',
          detectors: ['yagni:unused-config-surface'],
          categories: ['configuration'],
          includeTests: true,
          pathRoots: ['src'],
        },
        emit,
      ),
    ).resolves.toBe(result);

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
    );
    expect(emit).toHaveBeenNthCalledWith(1, {
      type: 'stage-start',
      stage: 'yagni:unused-config-surface',
      label: 'Unused Config Surface',
    });
    expect(emit).toHaveBeenNthCalledWith(2, {
      type: 'stage-done',
      stage: 'yagni:unused-config-surface',
      durationMs: 42,
    });
    expect(emit).toHaveBeenNthCalledWith(3, {
      type: 'stage-done',
      stage: 'yagni:disabled-stub',
      durationMs: 0,
      detail: 'skipped',
    });
  });

  it('forwards the command spec path to the sanctioned JSON worker', async () => {
    await yagniRunWorkerCommandSpec.handler?.({ _args: [COMMAND_SPEC_PATH] }, stubCli());

    expect(runJsonSpecWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({ specPath: COMMAND_SPEC_PATH }),
    );
  });
});
