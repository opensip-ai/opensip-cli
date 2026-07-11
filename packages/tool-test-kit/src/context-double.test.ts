import { createSignal } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import {
  assertCommandResult,
  assertReportFailureDetail,
  assertSignalEnvelope,
  createToolCliContextDouble,
  makeTestScope,
  runCommandSpec,
  withScope,
  withScopeSync,
} from './index.js';

import type {
  CommandSpec,
  GateCompareResult,
  LiveViewContext,
  LiveViewRenderer,
  ToolCliContext,
} from '@opensip-cli/core';

const command: CommandSpec<{ readonly json?: boolean }, ToolCliContext> = {
  name: 'sample',
  description: 'sample command',
  commonFlags: [],
  scope: 'project',
  output: 'command-result',
  handler: async (opts, cli) => {
    if (opts.json === true) cli.emitJson({ ok: true });
    await cli.toolState.put('sample', 'last', opts);
    await cli.writeArtifact('out.json', '{"ok":true}\n');
    return { type: 'text-lines', lines: ['done'] };
  },
};

function sampleEnvelope(): unknown {
  return {
    schemaVersion: 2,
    tool: 'sample',
    runId: 'run_test',
    createdAt: '2026-01-01T00:00:00.000Z',
    verdict: {
      score: 1,
      passed: true,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
    },
    units: [],
    signals: [],
    baselineIdentity: {
      fingerprintStrategyId: 'test',
      fingerprintStrategyVersion: '1',
    },
  };
}

describe('createToolCliContextDouble', () => {
  it('runs a command spec and captures host seam calls', async () => {
    const double = createToolCliContextDouble();
    const run = await runCommandSpec(command, { json: true }, double);

    assertCommandResult(run.result);
    expect(run.result.type).toBe('text-lines');
    expect(run.captured.json).toEqual([{ ok: true }]);
    expect(run.captured.artifactWrites).toEqual([{ path: 'out.json', bytes: '{"ok":true}\n' }]);
    await expect(run.ctx.toolState.get('sample', 'last')).resolves.toEqual({
      json: true,
    });
  });

  it('captures reportFailure details with unknown throwables', async () => {
    const double = createToolCliContextDouble();
    const detail = assertReportFailureDetail({
      error: { thrown: 'plain object' },
      jsonRequested: true,
    });

    await double.ctx.reportFailure(detail);
    expect(double.captured.reportFailures).toEqual([detail]);
  });

  it('captures envelopes and validates envelope shape', () => {
    const double = createToolCliContextDouble();
    const envelope = sampleEnvelope();
    assertSignalEnvelope(envelope);

    double.ctx.emitEnvelope(envelope);
    expect(double.captured.envelopes).toEqual([envelope]);
  });

  it('captures every documented host seam exposed by the double', async () => {
    const envelope = sampleEnvelope();
    const compareResult: GateCompareResult = {
      added: [
        createSignal({ source: 'fit', severity: 'high', ruleId: 'new', message: 'new finding' }),
      ],
      resolved: [],
      unchanged: [],
      degraded: true,
    };
    const double = createToolCliContextDouble({
      deliveryResult: { cloudAccepted: 1 },
      compareResult,
    });

    await double.ctx.render({ type: 'text-lines', lines: ['rendered'] });
    // The double stores a renderer and returns its value verbatim from
    // `renderLive`; these stubs deliberately return an inspectable shape (not a
    // real ToolRunCompletion) so the test can assert the args/result
    // pass-through and the duplicate-registration warning.
    double.ctx.registerLiveView('sample-live', ((args: unknown, liveContext?: LiveViewContext) => ({
      args,
      elapsedMs: liveContext?.runSession.timing.elapsedMs(),
    })) as unknown as LiveViewRenderer);
    double.ctx.registerLiveView('sample-live', (() => ({
      duplicate: true,
    })) as unknown as LiveViewRenderer);
    await expect(double.ctx.renderLive('sample-live', { ok: true })).resolves.toMatchObject({
      args: { ok: true },
    });
    await expect(double.ctx.renderLive('missing-live', {})).rejects.toBeInstanceOf(Error);

    await double.ctx.maybeOpenReport({
      openRequested: true,
      jsonOutput: false,
    });
    await double.ctx.reportFailure({ message: 'reported', exitCode: 2 });
    double.ctx.setExitCode(7);
    double.ctx.emitError({
      message: 'bad input',
      exitCode: 2,
      code: 'BAD_INPUT',
    });
    double.ctx.emitRaw('raw text');
    await expect(
      double.ctx.deliverSignals(envelope, {
        cwd: '/repo',
        reportTo: 'cloud',
        apiKey: 'redacted',
        runFailed: true,
      }),
    ).resolves.toEqual({ cloudAccepted: 1 });
    await double.ctx.writeSarif(envelope, 'out.sarif');
    await double.ctx.writeArtifact('artifact.json', '{"ok":true}\n');
    await double.ctx.ensureArtifactDir('artifacts');
    await double.ctx.saveBaseline('fit', envelope);
    await expect(double.ctx.compareBaseline('fit', envelope)).resolves.toBe(compareResult);
    await double.ctx.exportBaselineSarif('fit', 'fit.sarif');
    await double.ctx.exportBaselineFingerprints('fit', 'fit-baseline.json');
    await double.ctx.toolState.put('fit', 'one', { value: 1 });
    await double.ctx.toolState.put('fit', 'two', { value: 2 });
    await expect(double.ctx.toolState.list('fit')).resolves.toEqual(['one', 'two']);
    await double.ctx.toolState.delete('fit', 'one');
    await expect(double.ctx.toolState.get('fit', 'one')).resolves.toBeUndefined();
    double.ctx.logger.debug('debug');
    double.ctx.logger.info('info');
    double.ctx.logger.warn('warn');
    double.ctx.logger.error('error');

    expect(double.ctx.getExitCode?.()).toBe(2);
    expect(double.captured.rendered).toHaveLength(1);
    expect(double.captured.liveRenders).toEqual([
      { key: 'sample-live', args: { ok: true } },
      { key: 'missing-live', args: {} },
    ]);
    expect(double.captured.maybeOpenReport).toEqual([{ openRequested: true, jsonOutput: false }]);
    expect(double.captured.reportFailures).toEqual([{ message: 'reported', exitCode: 2 }]);
    expect(double.captured.exitCodes).toEqual([7, 2]);
    expect(double.captured.errors).toEqual([
      { message: 'bad input', exitCode: 2, code: 'BAD_INPUT' },
    ]);
    expect(double.captured.raw).toEqual(['raw text']);
    expect(double.captured.deliveredSignals).toEqual([
      {
        envelope,
        opts: {
          cwd: '/repo',
          reportTo: 'cloud',
          apiKey: 'redacted',
          runFailed: true,
        },
      },
    ]);
    expect(double.captured.sarifWrites).toEqual([{ envelope, path: 'out.sarif' }]);
    expect(double.captured.artifactWrites).toEqual([
      { path: 'artifact.json', bytes: '{"ok":true}\n' },
    ]);
    expect(double.captured.ensuredArtifactDirs).toEqual(['artifacts']);
    expect(double.captured.savedBaselines).toEqual([{ tool: 'fit', envelope }]);
    expect(double.captured.comparedBaselines).toEqual([{ tool: 'fit', envelope }]);
    expect(double.captured.exportedBaselineSarif).toEqual([{ tool: 'fit', path: 'fit.sarif' }]);
    expect(double.captured.exportedBaselineFingerprints).toEqual([
      { tool: 'fit', path: 'fit-baseline.json' },
    ]);
    expect(double.captured.logs.map((entry) => entry.level)).toEqual([
      'warn',
      'debug',
      'info',
      'warn',
      'error',
    ]);
  });
});

describe('assertion helpers', () => {
  it('throws typed assertion errors for malformed command results', () => {
    expect(() => assertCommandResult(null)).toThrow(TypeError);
    expect(() => assertCommandResult({ type: '' })).toThrow(TypeError);
  });

  it('throws typed assertion errors for malformed signal envelopes', () => {
    expect(() => assertSignalEnvelope(null)).toThrow(TypeError);
    expect(() => assertSignalEnvelope({ schemaVersion: 1 })).toThrow(TypeError);
    expect(() => assertSignalEnvelope({ schemaVersion: 2, tool: '' })).toThrow(TypeError);
    expect(() => assertSignalEnvelope({ schemaVersion: 2, tool: 'fit', runId: '' })).toThrow(
      TypeError,
    );
    expect(() => assertSignalEnvelope({ schemaVersion: 2, tool: 'fit', runId: 'run_1' })).toThrow(
      TypeError,
    );
    expect(() =>
      assertSignalEnvelope({
        schemaVersion: 2,
        tool: 'fit',
        runId: 'run_1',
        verdict: {},
        units: {},
      }),
    ).toThrow(TypeError);
    expect(() =>
      assertSignalEnvelope({
        schemaVersion: 2,
        tool: 'fit',
        runId: 'run_1',
        verdict: {},
        units: [],
        signals: {},
      }),
    ).toThrow(TypeError);
  });

  it('throws typed assertion errors for malformed report failure details', () => {
    expect(() => assertReportFailureDetail(null)).toThrow(TypeError);
    expect(() => assertReportFailureDetail({ message: 42 })).toThrow(TypeError);
    expect(() => assertReportFailureDetail({ exitCode: '2' })).toThrow(TypeError);
    expect(() => assertReportFailureDetail({ jsonRequested: 'yes' })).toThrow(TypeError);
  });
});

describe('scope helpers', () => {
  it('run test bodies inside a provided scope', async () => {
    const scope = makeTestScope();
    await expect(withScope(scope, () => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(withScopeSync(scope, () => 42)).toBe(42);
    scope.dispose();
  });
});
