import { EXIT_CODES } from '@opensip-cli/contracts';
import { RunScope, runWithScope } from '@opensip-cli/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeWorkspaceGraph } from '../graph-workspace-mode.js';

import type { Logger, ToolCliContext } from '@opensip-cli/core';

const h = vi.hoisted(() => ({
  discoverPolyglotUnits: vi.fn(),
  runWorkspaceUnitsInParallel: vi.fn(),
  resolveAdaptersForRun: vi.fn(),
}));

vi.mock('../workspace-runner.js', () => ({
  discoverPolyglotUnits: h.discoverPolyglotUnits,
  runWorkspaceUnitsInParallel: h.runWorkspaceUnitsInParallel,
}));

vi.mock('../resolve-adapters.js', () => ({
  resolveAdaptersForRun: h.resolveAdaptersForRun,
}));

const unit = {
  id: 'pkg-a',
  rootDir: '/repo/packages/a',
  configPath: '/repo/packages/a/tsconfig.json',
};

function mockCli(): {
  readonly cli: ToolCliContext;
  readonly emitJson: ReturnType<typeof vi.fn>;
  readonly render: ReturnType<typeof vi.fn>;
  readonly deliverSignals: ReturnType<typeof vi.fn>;
  readonly setExitCode: ReturnType<typeof vi.fn>;
} {
  const emitJson = vi.fn();
  const render = vi.fn(() => Promise.resolve());
  const deliverSignals = vi.fn(() => Promise.resolve({ delivered: false }));
  const setExitCode = vi.fn();
  return {
    cli: {
      emitJson,
      render,
      deliverSignals,
      setExitCode,
      scope: { languages: { getAll: vi.fn(() => []) } },
    } as unknown as ToolCliContext,
    emitJson,
    render,
    deliverSignals,
    setExitCode,
  };
}

function completionLogger(): {
  readonly info: ReturnType<typeof vi.fn>;
  readonly scope: RunScope;
} {
  const info = vi.fn();
  const logger: Logger = {
    debug: vi.fn(),
    info,
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { info, scope: new RunScope({ logger }) };
}

function completionEvents(info: ReturnType<typeof vi.fn>): readonly Record<string, unknown>[] {
  return info.mock.calls
    .map(([entry]) => entry as Record<string, unknown>)
    .filter((entry) => entry.evt === 'graph.cli.graph.complete');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveAdaptersForRun.mockReturnValue([{ id: 'typescript' }]);
  h.discoverPolyglotUnits.mockResolvedValue([unit]);
  h.runWorkspaceUnitsInParallel.mockResolvedValue({
    perUnit: [
      {
        unitId: unit.id,
        rootDir: unit.rootDir,
        displayPath: 'packages/a',
        signals: [],
        exitCode: 0,
        stderr: '',
      },
    ],
    anyChildFailed: false,
  });
});

describe('executeWorkspaceGraph evidence', () => {
  it('returns one aggregate parent session in human mode without aggregate egress', async () => {
    const { cli, emitJson, render, deliverSignals } = mockCli();
    const { info, scope } = completionLogger();

    const outcome = await runWithScope(scope, () =>
      executeWorkspaceGraph({ cwd: '/repo', cliScript: '/repo/opensip.cjs' }, cli),
    );

    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'workspace-parent',
        session: expect.objectContaining({ tool: 'graph', cwd: '/repo' }),
      }),
    );
    expect(outcome?.envelope).toBeUndefined();
    expect(render).toHaveBeenCalledTimes(1);
    expect(emitJson).not.toHaveBeenCalled();
    expect(deliverSignals).not.toHaveBeenCalled();
    const events = completionEvents(info);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      deliveryMode: 'workspace-parent',
      sessionContributed: true,
      envelopeReturned: false,
      workspaceChild: false,
    });
    expect(events[0]).not.toHaveProperty('payload');
    expect(events[0]).not.toHaveProperty('session');
    expect(events[0]).not.toHaveProperty('envelope');
  });

  it('returns the same aggregate parent session in JSON mode and changes only presentation', async () => {
    const { cli, emitJson, render, deliverSignals } = mockCli();
    const { info, scope } = completionLogger();

    const outcome = await runWithScope(scope, () =>
      executeWorkspaceGraph(
        { cwd: '/repo', cliScript: '/repo/opensip.cjs', json: true },
        cli,
      ),
    );

    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'workspace-parent',
        session: expect.objectContaining({ tool: 'graph', cwd: '/repo' }),
      }),
    );
    expect(outcome?.envelope).toBeUndefined();
    expect(emitJson).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    expect(deliverSignals).not.toHaveBeenCalled();
    const events = completionEvents(info);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      deliveryMode: 'workspace-parent',
      sessionContributed: true,
      envelopeReturned: false,
      workspaceChild: false,
    });
  });

  it.each([
    ['human', false],
    ['JSON', true],
  ] as const)(
    'marks the aggregate session as an incomplete error when a child fails in %s mode',
    async (_mode, json) => {
      h.runWorkspaceUnitsInParallel.mockResolvedValueOnce({
        perUnit: [
          {
            unitId: unit.id,
            rootDir: unit.rootDir,
            displayPath: 'packages/a',
            signals: [],
            exitCode: 1,
            stderr: 'child failed',
          },
        ],
        anyChildFailed: true,
      });
      const { cli, emitJson, render, setExitCode } = mockCli();
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const outcome = await executeWorkspaceGraph(
          { cwd: '/repo', cliScript: '/repo/opensip.cjs', ...(json ? { json: true } : {}) },
          cli,
        );

        expect(outcome?.session).toMatchObject({
          passed: false,
          score: 0,
          runOutcome: 'error',
        });
        expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
        expect(json ? emitJson : render).toHaveBeenCalledTimes(1);
        expect(json ? render : emitJson).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
    },
  );
});
