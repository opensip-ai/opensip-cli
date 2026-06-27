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

import type { CommandSpec, ToolCliContext } from '@opensip-cli/core';

const command: CommandSpec<{ readonly json?: boolean }, ToolCliContext> = {
  name: 'sample',
  description: 'sample command',
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
    await expect(run.ctx.toolState.get('sample', 'last')).resolves.toEqual({ json: true });
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
});

describe('scope helpers', () => {
  it('run test bodies inside a provided scope', async () => {
    const scope = makeTestScope();
    await expect(withScope(scope, () => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(withScopeSync(scope, () => 42)).toBe(42);
    scope.dispose();
  });
});
