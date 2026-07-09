import { EXIT_CODES, mapToolErrorToExitCode } from '@opensip-cli/contracts';
import {
  ConfigurationError,
  NetworkError,
  RunScope,
  defineCommand,
  runWithScope,
  type ReportFailureDetail,
  type ToolCliContext,
} from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { RunRepo, SessionRepo } from '@opensip-cli/session-store';
import { describe, expect, it, vi } from 'vitest';

import { createRunActionHooks, createRunPlaneFactory } from '../../bootstrap/run-plane.js';
import { runCommandSpecAction } from '../run-command-spec-action.js';

function makeCtx(overrides: Partial<ToolCliContext> = {}): ToolCliContext {
  return {
    render: vi.fn(() => Promise.resolve()),
    setExitCode: vi.fn(),
    getExitCode: vi.fn(() => undefined),
    emitJson: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve({ cloudAccepted: 0 })),
    writeSarif: vi.fn(() => Promise.resolve()),
    ...overrides,
  } as unknown as ToolCliContext;
}

describe('runCommandSpecAction', () => {
  it('runs handler output through dispatch and lifecycle hooks', async () => {
    const beginRun = vi.fn();
    const completeRun = vi.fn();
    const spec = defineCommand<Record<string, unknown>, ToolCliContext>({
      name: 'fixture',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler: () => ({ type: 'help' }),
    });
    const ctx = makeCtx();

    await runCommandSpecAction(spec, { json: false, _args: [] }, [], ctx, {
      beginRun,
      completeRun,
    });

    expect(beginRun).toHaveBeenCalledTimes(1);
    expect(completeRun).toHaveBeenCalledWith({ type: 'help' });
    expect(ctx.render).toHaveBeenCalledWith({ type: 'help' });
  });

  it('skips handler and output when external dispatch handles the command', async () => {
    const handler = vi.fn(() => ({ type: 'help' }) as const);
    const maybeDispatchExternal = vi.fn(() => Promise.resolve(true));
    const completeRun = vi.fn();
    const spec = defineCommand<Record<string, unknown>, ToolCliContext>({
      name: 'fixture',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler,
    });
    const ctx = makeCtx();

    await runCommandSpecAction(spec, { _args: ['src'] }, ['src'], ctx, {
      maybeDispatchExternal,
      completeRun,
    });

    expect(maybeDispatchExternal).toHaveBeenCalledWith('fixture', { _args: ['src'] }, ['src']);
    expect(handler).not.toHaveBeenCalled();
    expect(completeRun).not.toHaveBeenCalled();
    expect(ctx.render).not.toHaveBeenCalled();
  });

  it('persists an implicit one-step ledger run for verdict command completions', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const hooks = createRunActionHooks(
        createRunPlaneFactory({
          getDatastore: () => datastore,
        }),
      );
      const spec = defineCommand<Record<string, unknown>, ToolCliContext>({
        name: 'fit',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'raw-stream',
        rawStreamReason: 'runtime-render-dispatch',
        producesVerdict: true,
        handler: () => ({
          session: {
            tool: 'fit',
            cwd: '/proj',
            recipe: 'default',
            score: 100,
            passed: true,
            payload: {
              summary: {
                total: 1,
                passed: 1,
                failed: 0,
                errors: 0,
                warnings: 0,
              },
            },
          },
        }),
      });
      const ctx = makeCtx({ getExitCode: vi.fn(() => EXIT_CODES.SUCCESS) });
      const scope = new RunScope({
        datastore: () => datastore,
        runId: 'scope-run',
      });

      await runWithScope(scope, () =>
        runCommandSpecAction(spec, { cwd: '/proj', _args: [] }, [], ctx, hooks),
      );

      expect(new SessionRepo(datastore).count()).toBe(1);
      const runRepo = new RunRepo(datastore);
      const runs = runRepo.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        name: 'fit',
        source: 'implicit-tool',
        correlationRunId: 'scope-run',
        aggregate: {
          steps: 1,
          passed: 1,
          failed: 0,
          faulted: 0,
          errors: 0,
          warnings: 0,
        },
      });
      const steps = runRepo.listStepsForRun(runs[0]?.id ?? '');
      expect(steps[0]).toMatchObject({
        ordinal: 0,
        tool: 'fit',
        command: 'fit',
        outcome: 'passed',
        verdictSummary: { passed: true, errors: 0, warnings: 0, findings: 0 },
      });
      expect(steps[0]?.sessionId).toBeDefined();
    } finally {
      datastore.close();
    }
  });

  it('persists a faulted implicit ledger run when verdict commands throw before evidence is returned', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const hooks = createRunActionHooks(
        createRunPlaneFactory({
          getDatastore: () => datastore,
        }),
      );
      const error = new ConfigurationError('bad config');
      const spec = defineCommand<Record<string, unknown>, ToolCliContext>({
        name: 'fit',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'raw-stream',
        rawStreamReason: 'runtime-render-dispatch',
        producesVerdict: true,
        handler: () => {
          throw error;
        },
      });
      let exitCode: number | undefined;
      const setExitCode = vi.fn((code: number) => {
        exitCode = code;
      });
      const getExitCode = vi.fn(() => exitCode);
      const ctx = makeCtx({ setExitCode, getExitCode });
      const scope = new RunScope({
        datastore: () => datastore,
        runId: 'scope-run',
      });

      await runWithScope(scope, () =>
        runCommandSpecAction(spec, { cwd: '/proj', _args: [] }, [], ctx, hooks),
      );

      expect(setExitCode).toHaveBeenCalledWith(mapToolErrorToExitCode(error));
      expect(new SessionRepo(datastore).count()).toBe(0);
      const runRepo = new RunRepo(datastore);
      const runs = runRepo.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        name: 'fit',
        source: 'implicit-tool',
        correlationRunId: 'scope-run',
        exitCode: EXIT_CODES.CONFIGURATION_ERROR,
        aggregate: {
          steps: 1,
          passed: 0,
          failed: 0,
          faulted: 1,
          errors: 0,
          warnings: 0,
        },
      });
      const steps = runRepo.listStepsForRun(runs[0]?.id ?? '');
      expect(steps[0]).toMatchObject({
        ordinal: 0,
        tool: 'fit',
        command: 'fit',
        outcome: 'faulted',
        exitCode: EXIT_CODES.CONFIGURATION_ERROR,
        evidence: { missing: 'session-or-envelope' },
      });
      expect(steps[0]?.sessionId).toBeUndefined();
      expect(steps[0]?.verdictSummary).toBeUndefined();
    } finally {
      datastore.close();
    }
  });

  it('captures reportFailure and skips dispatch when a reporting handler returns void', async () => {
    const reportFailure = vi.fn((_detail: ReportFailureDetail) => Promise.resolve());
    const spec = defineCommand<Record<string, unknown>, ToolCliContext>({
      name: 'fixture',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler: async (_opts, cli) => {
        await cli.reportFailure?.({
          message: 'reported',
          exitCode: EXIT_CODES.CONFIGURATION_ERROR,
        });
      },
    });
    const ctx = makeCtx({ reportFailure });

    await runCommandSpecAction(spec, { _args: [] }, [], ctx);

    expect(reportFailure).toHaveBeenCalledWith({
      message: 'reported',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
    expect(ctx.render).not.toHaveBeenCalled();
  });

  it('maps ToolError through setExitCode when no reportFailure seam exists', async () => {
    const error = new ConfigurationError('bad config');
    const spec = defineCommand<Record<string, unknown>, ToolCliContext>({
      name: 'fixture',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler: () => {
        throw error;
      },
    });
    const ctx = makeCtx();

    await runCommandSpecAction(spec, { _args: [] }, [], ctx);

    expect(ctx.setExitCode).toHaveBeenCalledWith(mapToolErrorToExitCode(error));
    expect(ctx.render).not.toHaveBeenCalled();
  });

  it('routes ToolError through reportFailure when available', async () => {
    const error = new NetworkError('upload failed');
    const reportFailure = vi.fn((_detail: ReportFailureDetail) => Promise.resolve());
    const spec = defineCommand<Record<string, unknown>, ToolCliContext>({
      name: 'fixture',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler: () => {
        throw error;
      },
    });
    const ctx = makeCtx({ reportFailure });

    await runCommandSpecAction(spec, { json: true, _args: [] }, [], ctx);

    expect(reportFailure).toHaveBeenCalledWith({ error, jsonRequested: true });
    expect(ctx.setExitCode).not.toHaveBeenCalled();
  });
});
