import { buildSignalEnvelope, EXIT_CODES, mapToolErrorToExitCode } from '@opensip-cli/contracts';
import {
  ConfigurationError,
  HOST_VERDICT_POLICY_FALLBACK,
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
    const spec = defineCommand<unknown, ToolCliContext>({
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
    const spec = defineCommand<unknown, ToolCliContext>({
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
      const spec = defineCommand<unknown, ToolCliContext>({
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

  it.each([
    ['human', {}],
    ['json', { json: true }],
    ['gate', { gateSave: true }],
    ['catalog', { catalogOutput: '/proj/catalog.json' }],
    ['sarif', { sarif: '/proj/graph.sarif' }],
    ['report-to', { reportTo: 'https://example.invalid/receiver' }],
  ] as const)(
    'persists linked, non-faulted graph evidence for %s presentation',
    async (_mode, modeOptions) => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        const hooks = createRunActionHooks(
          createRunPlaneFactory({
            getDatastore: () => datastore,
          }),
        );
        const envelope = buildSignalEnvelope({
          tool: 'graph',
          runId: 'graph-run',
          createdAt: '2026-07-16T00:00:00.000Z',
          units: [{ slug: 'graph', passed: true, durationMs: 1 }],
          signals: [],
          policy: HOST_VERDICT_POLICY_FALLBACK,
          runFaulted: false,
        });
        const spec = defineCommand<unknown, ToolCliContext>({
          name: 'graph',
          description: 'fixture',
          commonFlags: [],
          scope: 'project',
          output: 'raw-stream',
          rawStreamReason: 'runtime-render-dispatch',
          producesVerdict: true,
          handler: () => ({
            envelope,
            session: {
              tool: 'graph',
              cwd: '/proj',
              recipe: 'default',
              score: 100,
              passed: true,
              payload: {
                summary: {
                  total: 0,
                  passed: 0,
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
          runId: 'scope-graph-run',
        });

        await runWithScope(scope, () =>
          runCommandSpecAction(spec, { cwd: '/proj', ...modeOptions, _args: [] }, [], ctx, hooks),
        );

        expect(new SessionRepo(datastore).count()).toBe(1);
        const runRepo = new RunRepo(datastore);
        const runs = runRepo.listRuns();
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({
          name: 'graph',
          source: 'implicit-tool',
          correlationRunId: 'scope-graph-run',
          aggregate: {
            steps: 1,
            passed: 1,
            failed: 0,
            faulted: 0,
          },
        });
        const steps = runRepo.listStepsForRun(runs[0]?.id ?? '');
        expect(steps).toHaveLength(1);
        expect(steps[0]).toMatchObject({
          tool: 'graph',
          command: 'graph',
          outcome: 'passed',
        });
        expect(steps[0]?.sessionId).toBeDefined();
        expect(steps[0]?.evidence).toBeDefined();
        expect(steps[0]?.evidence).not.toMatchObject({
          missing: 'session-or-envelope',
        });
      } finally {
        datastore.close();
      }
    },
  );

  it('records a failed workspace child as a faulted aggregate graph parent step', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const hooks = createRunActionHooks(
        createRunPlaneFactory({
          getDatastore: () => datastore,
        }),
      );
      const spec = defineCommand<unknown, ToolCliContext>({
        name: 'graph',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'raw-stream',
        rawStreamReason: 'runtime-render-dispatch',
        producesVerdict: true,
        handler: () => ({
          session: {
            tool: 'graph',
            cwd: '/proj',
            recipe: 'default',
            score: 0,
            passed: false,
            runOutcome: 'error',
            payload: {
              summary: {
                total: 0,
                passed: 0,
                failed: 0,
                errors: 0,
                warnings: 0,
              },
            },
          },
        }),
      });
      const ctx = makeCtx({ getExitCode: vi.fn(() => EXIT_CODES.RUNTIME_ERROR) });
      const scope = new RunScope({
        datastore: () => datastore,
        runId: 'scope-workspace-run',
      });

      await runWithScope(scope, () =>
        runCommandSpecAction(
          spec,
          { cwd: '/proj', workspace: true, json: true, _args: [] },
          [],
          ctx,
          hooks,
        ),
      );

      expect(new SessionRepo(datastore).count()).toBe(1);
      const runRepo = new RunRepo(datastore);
      const runs = runRepo.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        name: 'graph',
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        aggregate: {
          steps: 1,
          passed: 0,
          failed: 0,
          faulted: 1,
        },
      });
      const steps = runRepo.listStepsForRun(runs[0]?.id ?? '');
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        tool: 'graph',
        command: 'graph',
        outcome: 'faulted',
        exitCode: EXIT_CODES.RUNTIME_ERROR,
      });
      expect(steps[0]?.sessionId).toBeDefined();
      expect(steps[0]?.evidence).toBeDefined();
      expect(steps[0]?.evidence).not.toMatchObject({
        missing: 'session-or-envelope',
      });
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
      const spec = defineCommand<unknown, ToolCliContext>({
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

  it('skips a delegated supervisor row when its correlated child run is already persisted', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const runRepo = new RunRepo(datastore);
      runRepo.saveRunWithSteps(
        {
          id: 'child-run',
          name: 'graph',
          source: 'implicit-tool',
          correlationRunId: 'scope-run',
          cwd: '/proj',
          startedAt: '2026-07-09T23:22:20.000Z',
          completedAt: '2026-07-09T23:22:40.000Z',
          durationMs: 20_000,
          exitCode: EXIT_CODES.SUCCESS,
          aggregate: {
            steps: 1,
            passed: 1,
            failed: 0,
            faulted: 0,
            errors: 0,
            warnings: 0,
          },
        },
        [
          {
            id: 'child-step',
            runId: 'child-run',
            logicalStepKey: '0:graph:graph',
            ordinal: 0,
            attempt: 1,
            tool: 'graph',
            command: 'graph',
            stableId: 'graph',
            exitCode: EXIT_CODES.SUCCESS,
            outcome: 'passed',
            durationMs: 20_000,
          },
        ],
      );
      const hooks = createRunActionHooks(
        createRunPlaneFactory({
          getDatastore: () => datastore,
        }),
      );
      const spec = defineCommand<unknown, ToolCliContext>({
        name: 'graph',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'raw-stream',
        rawStreamReason: 'runtime-render-dispatch',
        producesVerdict: true,
        handler: () => ({
          execution: { kind: 'delegated', startedAt: '2026-07-09T23:22:19.000Z' },
        }),
      });
      const ctx = makeCtx({ getExitCode: vi.fn(() => EXIT_CODES.SUCCESS) });
      const scope = new RunScope({ datastore: () => datastore, runId: 'scope-run' });

      await runWithScope(scope, () =>
        runCommandSpecAction(spec, { cwd: '/proj', _args: [] }, [], ctx, hooks),
      );

      expect(new SessionRepo(datastore).count()).toBe(0);
      expect(runRepo.listRuns().map((run) => run.id)).toEqual(['child-run']);
      expect(runRepo.listStepsForRun('child-run')).toHaveLength(1);
    } finally {
      datastore.close();
    }
  });

  it('retains the missing-evidence fault when delegated child proof is absent', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const hooks = createRunActionHooks(
        createRunPlaneFactory({
          getDatastore: () => datastore,
        }),
      );
      const spec = defineCommand<unknown, ToolCliContext>({
        name: 'graph',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'raw-stream',
        rawStreamReason: 'runtime-render-dispatch',
        producesVerdict: true,
        handler: () => ({
          execution: { kind: 'delegated', startedAt: '2026-07-09T23:22:19.000Z' },
        }),
      });
      const ctx = makeCtx({ getExitCode: vi.fn(() => EXIT_CODES.RUNTIME_ERROR) });
      const scope = new RunScope({ datastore: () => datastore, runId: 'scope-run' });

      await runWithScope(scope, () =>
        runCommandSpecAction(spec, { cwd: '/proj', _args: [] }, [], ctx, hooks),
      );

      const runRepo = new RunRepo(datastore);
      const runs = runRepo.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        name: 'graph',
        correlationRunId: 'scope-run',
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        aggregate: { faulted: 1 },
      });
      expect(runRepo.listStepsForRun(runs[0]?.id ?? '')[0]).toMatchObject({
        tool: 'graph',
        command: 'graph',
        outcome: 'faulted',
        evidence: { missing: 'session-or-envelope' },
      });
    } finally {
      datastore.close();
    }
  });

  it('captures reportFailure and skips dispatch when a reporting handler returns void', async () => {
    const reportFailure = vi.fn((_detail: ReportFailureDetail) => Promise.resolve());
    const spec = defineCommand<unknown, ToolCliContext>({
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

  it('presents ToolError through render when no reportFailure seam exists', async () => {
    // A typed failure must never exit silently: contexts without the
    // reportFailure seam still get the error view through the guaranteed
    // render seam (and setExitCode).
    const error = new ConfigurationError('bad config');
    const spec = defineCommand<unknown, ToolCliContext>({
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
    expect(ctx.render).toHaveBeenCalledWith({
      type: 'error',
      message: 'bad config',
      exitCode: mapToolErrorToExitCode(error),
    });
  });

  it('routes ToolError through reportFailure when available', async () => {
    const error = new NetworkError('upload failed');
    const reportFailure = vi.fn((_detail: ReportFailureDetail) => Promise.resolve());
    const spec = defineCommand<unknown, ToolCliContext>({
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

  it('runs its one finalizer after normal output replay', async () => {
    const events: string[] = [];
    const finalizeRun = vi.fn(() => {
      events.push('finalize');
      return Promise.resolve({ status: 'discarded' as const });
    });
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'fixture',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler: () => {
        events.push('handler');
        return { type: 'help' };
      },
    });
    const ctx = makeCtx({
      render: vi.fn(() => {
        events.push('render');
        return Promise.resolve();
      }),
    });
    await runCommandSpecAction(spec, { _args: [] }, [], ctx, {
      completeRun: () => events.push('complete'),
      finalizeRun,
    });
    expect(events).toEqual(['handler', 'complete', 'render', 'finalize']);
    expect(finalizeRun).toHaveBeenCalledOnce();
  });

  it('finalizes exactly once when output replay throws and preserves the output error', async () => {
    const outputError = new Error('render failed');
    const finalizeRun = vi.fn(() =>
      Promise.resolve({
        status: 'committed' as const,
        sessionIds: [],
        sessionCount: 0,
        stepCount: 0,
        serializedBytes: 0,
        persistMs: 0,
      }),
    );
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'fixture',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler: () => ({ type: 'help' }),
    });
    const ctx = makeCtx({ render: vi.fn(() => Promise.reject(outputError)) });
    await expect(runCommandSpecAction(spec, { _args: [] }, [], ctx, { finalizeRun })).rejects.toBe(
      outputError,
    );
    expect(finalizeRun).toHaveBeenCalledOnce();
  });

  it.each(['reported-failure', 'tool-error', 'unexpected', 'external'] as const)(
    'finalizes exactly once on the %s exit branch',
    async (branch) => {
      const finalizeRun = vi.fn(() => Promise.resolve({ status: 'discarded' as const }));
      const error =
        branch === 'tool-error' ? new ConfigurationError('typed') : new Error('unexpected');
      const spec = defineCommand<unknown, ToolCliContext>({
        name: 'fixture',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'command-result',
        handler:
          branch === 'reported-failure'
            ? async (_opts, cli) => {
                await cli.reportFailure?.({ message: 'reported', exitCode: 2 });
              }
            : () => {
                throw error;
              },
      });
      const ctx = makeCtx({
        reportFailure: vi.fn(() => Promise.resolve()),
      });
      const action = runCommandSpecAction(spec, { _args: [] }, [], ctx, {
        finalizeRun,
        ...(branch === 'external' ? { maybeDispatchExternal: () => Promise.resolve(true) } : {}),
      });
      if (branch === 'unexpected') await expect(action).rejects.toBe(error);
      else await expect(action).resolves.toBeUndefined();
      expect(finalizeRun).toHaveBeenCalledOnce();
    },
  );

  it('commits a legitimate non-verdict Session without inventing a parent Run', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const hooks = createRunActionHooks(createRunPlaneFactory({ getDatastore: () => datastore }));
      const spec = defineCommand<unknown, ToolCliContext>({
        name: 'inventory',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'raw-stream',
        rawStreamReason: 'runtime-render-dispatch',
        handler: () => ({ session: { tool: 'fit', cwd: '/proj', score: 100, passed: true } }),
      });
      await runWithScope(new RunScope({ datastore: () => datastore }), () =>
        runCommandSpecAction(spec, { _args: [] }, [], makeCtx(), hooks),
      );
      expect(new SessionRepo(datastore).count()).toBe(1);
      expect(new RunRepo(datastore).listRuns()).toHaveLength(0);
    } finally {
      datastore.close();
    }
  });

  it('does not invent a parent for a verdict command running in list mode', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const hooks = createRunActionHooks(createRunPlaneFactory({ getDatastore: () => datastore }));
      const spec = defineCommand<unknown, ToolCliContext>({
        name: 'fit',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'command-result',
        producesVerdict: true,
        handler: () => ({ type: 'help' }),
      });
      await runWithScope(new RunScope({ datastore: () => datastore }), () =>
        runCommandSpecAction(spec, { list: true, _args: [] }, [], makeCtx(), hooks),
      );
      expect(new SessionRepo(datastore).count()).toBe(0);
      expect(new RunRepo(datastore).listRuns()).toHaveLength(0);
    } finally {
      datastore.close();
    }
  });

  it('commits an envelope-backed parent without requiring a Session', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const hooks = createRunActionHooks(createRunPlaneFactory({ getDatastore: () => datastore }));
      const runEnvelope = buildSignalEnvelope({
        tool: 'graph',
        runId: 'envelope-only',
        createdAt: '2026-07-16T00:00:00.000Z',
        units: [{ slug: 'graph', passed: true, durationMs: 1 }],
        signals: [],
        policy: HOST_VERDICT_POLICY_FALLBACK,
        runFaulted: false,
      });
      const spec = defineCommand<unknown, ToolCliContext>({
        name: 'graph',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'raw-stream',
        rawStreamReason: 'runtime-render-dispatch',
        producesVerdict: true,
        handler: () => ({ envelope: runEnvelope }),
      });
      await runWithScope(new RunScope({ datastore: () => datastore }), () =>
        runCommandSpecAction(spec, { cwd: '/proj', _args: [] }, [], makeCtx(), hooks),
      );
      expect(new SessionRepo(datastore).count()).toBe(0);
      const runs = new RunRepo(datastore).listRuns();
      expect(runs).toHaveLength(1);
      const step = new RunRepo(datastore).listStepsForRun(runs[0].id)[0];
      expect(step).toMatchObject({
        outcome: 'passed',
        evidence: { kind: 'signal-envelope', runId: 'envelope-only' },
      });
      expect(step.sessionId).toBeUndefined();
    } finally {
      datastore.close();
    }
  });

  it('stamps an envelope-only parent with the canonical host project root', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const hooks = createRunActionHooks(createRunPlaneFactory({ getDatastore: () => datastore }));
      const runEnvelope = buildSignalEnvelope({
        tool: 'graph',
        runId: 'canonical-envelope',
        createdAt: '2026-07-16T00:00:00.000Z',
        units: [{ slug: 'graph', passed: true, durationMs: 1 }],
        signals: [],
        policy: HOST_VERDICT_POLICY_FALLBACK,
        runFaulted: false,
      });
      const spec = defineCommand<unknown, ToolCliContext>({
        name: 'graph',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'raw-stream',
        rawStreamReason: 'runtime-render-dispatch',
        producesVerdict: true,
        handler: () => ({ envelope: runEnvelope }),
      });
      const scope = new RunScope({
        datastore: () => datastore,
        projectContext: {
          cwd: '/literal/alias',
          cwdExplicit: true,
          projectRoot: '/canonical/project',
          configPath: '/canonical/project/opensip-cli.config.yml',
          walkedUp: 0,
          scope: 'project',
        },
      });

      await runWithScope(scope, () =>
        runCommandSpecAction(spec, { cwd: '/literal/alias', _args: [] }, [], makeCtx(), hooks),
      );

      expect(new RunRepo(datastore).listRuns()[0]?.cwd).toBe('/canonical/project');
    } finally {
      datastore.close();
    }
  });

  it('projects from the pre-output immutable envelope snapshot', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const hooks = createRunActionHooks(createRunPlaneFactory({ getDatastore: () => datastore }));
      const runEnvelope = buildSignalEnvelope({
        tool: 'graph',
        runId: 'immutable-envelope',
        createdAt: '2026-07-16T00:00:00.000Z',
        units: [{ slug: 'graph', passed: true, durationMs: 1 }],
        signals: [],
        policy: HOST_VERDICT_POLICY_FALLBACK,
        runFaulted: false,
      });
      const spec = defineCommand<unknown, ToolCliContext>({
        name: 'graph',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'signal-envelope',
        producesVerdict: true,
        handler: () => runEnvelope,
      });
      const ctx = makeCtx({
        render: vi.fn((value: unknown) => {
          const mutable = value as { verdict: { passed: boolean }; signals: unknown[] };
          mutable.verdict.passed = false;
          mutable.signals.push({ fingerprint: 'late' });
          return Promise.resolve();
        }),
      });
      await runWithScope(new RunScope({ datastore: () => datastore }), () =>
        runCommandSpecAction(spec, { cwd: '/proj', _args: [] }, [], ctx, hooks),
      );
      const run = new RunRepo(datastore).listRuns()[0];
      expect(new RunRepo(datastore).listStepsForRun(run.id)[0]).toMatchObject({
        outcome: 'passed',
        evidence: { verdict: { passed: true }, signalCount: 0 },
      });
    } finally {
      datastore.close();
    }
  });

  it('rolls back both Session and parent without changing the Tool verdict on bundle failure', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const hooks = createRunActionHooks(
        createRunPlaneFactory({
          getDatastore: () => datastore,
          commitEvidence: () => ({ status: 'failed', reason: 'write-failed' }),
        }),
      );
      const spec = defineCommand<unknown, ToolCliContext>({
        name: 'fit',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'raw-stream',
        rawStreamReason: 'runtime-render-dispatch',
        producesVerdict: true,
        handler: () => ({
          session: { tool: 'fit', cwd: '/proj', score: 100, passed: true },
        }),
      });
      const ctx = makeCtx({ getExitCode: vi.fn(() => EXIT_CODES.SUCCESS) });
      await runWithScope(new RunScope({ datastore: () => datastore }), () =>
        runCommandSpecAction(spec, { cwd: '/proj', _args: [] }, [], ctx, hooks),
      );
      expect(ctx.setExitCode).not.toHaveBeenCalled();
      expect(new SessionRepo(datastore).count()).toBe(0);
      expect(new RunRepo(datastore).listRuns()).toHaveLength(0);
    } finally {
      datastore.close();
    }
  });
});
