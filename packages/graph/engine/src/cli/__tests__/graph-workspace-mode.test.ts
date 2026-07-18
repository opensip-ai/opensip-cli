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

function mockCli(configPath?: string): {
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
      scope: {
        languages: { getAll: vi.fn(() => []) },
        ...(configPath === undefined ? {} : { projectContext: { configPath } }),
      },
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
  it('forwards the parent OpenSIP config selection to workspace children', async () => {
    const configPath = '/repo/custom opensip.yml';
    const { cli } = mockCli(configPath);
    const { scope } = completionLogger();

    await runWithScope(scope, () =>
      executeWorkspaceGraph({ cwd: '/repo', cliScript: '/repo/opensip.cjs' }, cli),
    );

    expect(h.runWorkspaceUnitsInParallel).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo',
        configPath,
      }),
    );
  });

  it('forwards bootstrap’s canonical cwd when the explicit option was relative', async () => {
    const { cli } = mockCli('/repo/project/custom opensip.yml');
    (
      cli.scope as unknown as { projectContext: { cwd: string; configPath: string } }
    ).projectContext = {
      cwd: '/repo/project',
      configPath: '/repo/project/custom opensip.yml',
    };
    const { scope } = completionLogger();

    await runWithScope(scope, () =>
      executeWorkspaceGraph({ cwd: 'project', cliScript: '/repo/opensip.cjs' }, cli),
    );

    expect(h.discoverPolyglotUnits).toHaveBeenCalledWith('/repo/project', expect.any(Array));
    expect(h.runWorkspaceUnitsInParallel).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo/project',
        configPath: '/repo/project/custom opensip.yml',
      }),
    );
  });

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
      executeWorkspaceGraph({ cwd: '/repo', cliScript: '/repo/opensip.cjs', json: true }, cli),
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
