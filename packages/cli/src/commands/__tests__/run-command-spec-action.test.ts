import { EXIT_CODES, mapToolErrorToExitCode } from '@opensip-cli/contracts';
import {
  ConfigurationError,
  NetworkError,
  defineCommand,
  type ReportFailureDetail,
  type ToolCliContext,
} from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

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
