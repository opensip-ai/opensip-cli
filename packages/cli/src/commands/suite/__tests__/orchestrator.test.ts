import {
  DEFAULT_BASELINE_IDENTITY,
  EXIT_CODES,
  type SignalEnvelope,
  type SuiteStepSummary,
} from '@opensip-cli/contracts';
import {
  RunScope,
  defineCommand,
  runWithScope,
  type Tool,
  type ToolCliContext,
  type ToolProvenance,
} from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeDispatchHostCtx } from '../../../__tests__/harness/dispatch-host-ctx.js';
import { deriveSuiteAggregate, runSuite } from '../orchestrator.js';

const dispatchSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../bootstrap/dispatch-external-tool-command.js', () => ({
  dispatchExternalToolCommand: (args: unknown) => dispatchSpy(args),
}));

const TOOL_ID = '00000000-0000-4000-8000-000000000111';
const OTHER_TOOL_ID = '00000000-0000-4000-8000-000000000222';
const EXTERNAL_TOOL_ID = '00000000-0000-4000-8000-000000000333';

function tool(id: string, name: string, specs: Tool['commandSpecs']): Tool {
  return {
    metadata: {
      id,
      name,
      version: '0.0.0',
      description: 'fixture',
    },
    commands: (specs ?? []).map((spec) => ({ name: spec.name, description: spec.description })),
    commandSpecs: specs,
  };
}

function helpCommand(
  name: string,
  handler: (opts: unknown, cli: ToolCliContext) => { type: 'help' } | Promise<{ type: 'help' }>,
): NonNullable<Tool['commandSpecs']>[number] {
  return defineCommand<unknown, ToolCliContext>({
    name,
    description: 'fixture',
    commonFlags: [],
    scope: 'project',
    output: 'command-result',
    handler,
  });
}

function signalEnvelope(input: {
  readonly passed: boolean;
  readonly errors?: number;
  readonly warnings?: number;
  readonly findings?: number;
  readonly message?: string;
  readonly filePath?: string;
}): SignalEnvelope {
  const errors = input.errors ?? 0;
  const warnings = input.warnings ?? 0;
  const findings = input.findings ?? errors + warnings;
  const signals = Array.from({ length: findings }, (_, index) => ({
    id: `sig_${index}`,
    source: 'fixture-check',
    provider: 'fixture',
    severity: index < errors ? 'high' : 'low',
    category: 'quality',
    ruleId: 'fixture-rule',
    message: input.message ?? `fixture finding ${index}`,
    filePath: input.filePath ?? 'src/fixture.ts',
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  return {
    schemaVersion: 2,
    tool: 'fit',
    runId: 'run-fixture',
    createdAt: '2026-01-01T00:00:00.000Z',
    verdict: {
      score: input.passed ? 100 : 0,
      passed: input.passed,
      summary: {
        total: 1,
        passed: input.passed ? 1 : 0,
        failed: input.passed ? 0 : 1,
        errors,
        warnings,
      },
    },
    units: [],
    signals,
    baselineIdentity: DEFAULT_BASELINE_IDENTITY,
  } as SignalEnvelope;
}

function externalProvenance(): ToolProvenance {
  return {
    source: 'installed',
    id: 'external-fixture',
    stableId: EXTERNAL_TOOL_ID,
    version: '0.0.0',
    manifestHash: 'hash',
  };
}

afterEach(() => {
  dispatchSpy.mockReset();
});

describe('runSuite', () => {
  it('assembles step opts from CommandSpec options plus shared suite flags', async () => {
    const seen: Record<string, unknown>[] = [];
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'fit',
      description: 'fixture',
      commonFlags: ['cwd', 'json'],
      options: [
        {
          flag: '--tag',
          value: '<slug>',
          description: 'tag',
          arrayDefault: [],
          parse: (raw, prev) => [...(Array.isArray(prev) ? prev : []), raw],
        },
        {
          flag: '--count',
          value: '<n>',
          description: 'count',
          parse: (raw) => Number.parseInt(raw, 10),
        },
      ],
      scope: 'project',
      output: 'command-result',
      handler: (opts) => {
        seen.push(opts);
        return { type: 'help' };
      },
    });
    const host = makeDispatchHostCtx();

    await runSuite({
      name: 'security',
      suite: {
        steps: [
          {
            tool: TOOL_ID,
            command: 'fit',
            args: { tag: ['security', 'perf'], count: '3', _args: ['src'] },
          },
        ],
      },
      tools: [tool(TOOL_ID, 'fitness', [spec])],
      ctx: host.ctx,
      suiteOpts: { cwd: '/repo', json: false },
    });

    expect(seen).toEqual([
      {
        cwd: '/repo',
        json: false,
        tag: ['security', 'perf'],
        count: 3,
        _args: ['src'],
      },
    ]);
  });

  it('captures per-step exit codes without mutating the outer host context', async () => {
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'fit',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler: (_opts, cli) => {
        cli.setExitCode(EXIT_CODES.REPORT_FAILED);
        return { type: 'help' };
      },
    });
    const host = makeDispatchHostCtx();

    const result = await runSuite({
      name: 'security',
      suite: { steps: [{ tool: TOOL_ID, command: 'fit' }] },
      tools: [tool(TOOL_ID, 'fitness', [spec])],
      ctx: host.ctx,
      suiteOpts: {},
    });

    expect(result.exitCode).toBe(EXIT_CODES.REPORT_FAILED);
    expect(result.steps[0]?.exitCode).toBe(EXIT_CODES.REPORT_FAILED);
    expect(host.exitCodes).toEqual([]);
  });

  it('captures process.exit from a bundled step and restores process.exit afterward', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- process.exit has no `this` contract; this test preserves identity for restoration.
    const originalExit = process.exit;
    const after = vi.fn(() => ({ type: 'help' }) as const);
    const exiting = defineCommand<unknown, ToolCliContext>({
      name: 'exit-step',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler: () => process.exit(2),
    });
    const next = defineCommand<unknown, ToolCliContext>({
      name: 'after',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler: after,
    });

    const result = await runSuite({
      name: 'security',
      suite: {
        steps: [
          { tool: TOOL_ID, command: 'exit-step' },
          { tool: TOOL_ID, command: 'after' },
        ],
      },
      tools: [tool(TOOL_ID, 'fitness', [exiting, next])],
      ctx: makeDispatchHostCtx().ctx,
      suiteOpts: {},
    });

    expect(result.exitCode).toBe(2);
    expect(result.steps.map((step) => step.exitCode)).toEqual([2, 0]);
    expect(after).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- identity assertion verifies the guard restored process.exit.
    expect(process.exit).toBe(originalExit);
  });

  it('records thrown step failures and continues running later steps', async () => {
    const calls: string[] = [];
    const throws = defineCommand<unknown, ToolCliContext>({
      name: 'throws',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler: () => {
        calls.push('throws');
        throw new Error('step exploded');
      },
    });
    const after = defineCommand<unknown, ToolCliContext>({
      name: 'after',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler: () => {
        calls.push('after');
        return { type: 'help' };
      },
    });

    const result = await runSuite({
      name: 'security',
      suite: {
        steps: [
          { tool: TOOL_ID, command: 'throws' },
          { tool: OTHER_TOOL_ID, command: 'after' },
        ],
      },
      tools: [tool(TOOL_ID, 'fitness', [throws]), tool(OTHER_TOOL_ID, 'graph', [after])],
      ctx: makeDispatchHostCtx().ctx,
      suiteOpts: {},
    });

    expect(calls).toEqual(['throws', 'after']);
    expect(result.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
    expect(result.steps[0]).toMatchObject({
      command: 'throws',
      exitCode: EXIT_CODES.RUNTIME_ERROR,
      error: 'step exploded',
    });
    expect(result.steps[1]).toMatchObject({ command: 'after', exitCode: EXIT_CODES.SUCCESS });
  });

  it('captures external-dispatch replay through the step context for worst-of aggregation', async () => {
    dispatchSpy.mockImplementation((args: { ctx: ToolCliContext }) => {
      args.ctx.setExitCode(3);
      args.ctx.emitEnvelope(signalEnvelope({ passed: false, errors: 1, findings: 1 }));
    });
    const external = helpCommand('external-run', () => {
      throw new Error('external handler should not run in-process');
    });
    const bundled = helpCommand('bundled-ok', () => ({ type: 'help' }));
    const scope = new RunScope({ toolProvenance: [externalProvenance()] });

    const result = await runWithScope(scope, () =>
      runSuite({
        name: 'security',
        suite: {
          steps: [
            { tool: EXTERNAL_TOOL_ID, command: 'external-run' },
            { tool: TOOL_ID, command: 'bundled-ok' },
          ],
        },
        tools: [
          tool(EXTERNAL_TOOL_ID, 'external-fixture', [external]),
          tool(TOOL_ID, 'fitness', [bundled]),
        ],
        ctx: makeDispatchHostCtx().ctx,
        suiteOpts: {},
      }),
    );

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(3);
    expect(result.steps.map((step) => step.exitCode)).toEqual([3, 0]);
    expect(result.steps[0]).toMatchObject({
      stableId: EXTERNAL_TOOL_ID,
      verdict: { passed: false, errors: 1, warnings: 0, findings: 1 },
    });
  });

  it('summarizes a mixed bundled/external suite without collapsing outcome classes', async () => {
    dispatchSpy.mockImplementation((args: { ctx: ToolCliContext }) => {
      args.ctx.emitEnvelope(signalEnvelope({ passed: true, warnings: 1, findings: 1 }));
    });
    const empty = helpCommand('empty', async (_opts, cli) => {
      await cli.deliverSignals(signalEnvelope({ passed: true, findings: 0 }), { cwd: '/repo' });
      return { type: 'help' };
    });
    const error = helpCommand('error', async (_opts, cli) => {
      await cli.deliverSignals(signalEnvelope({ passed: false, errors: 2, findings: 2 }), {
        cwd: '/repo',
      });
      return { type: 'help' };
    });
    const failureWithoutFindings = helpCommand('failure-without-findings', (_opts, cli) => {
      cli.setExitCode(2);
      return { type: 'help' };
    });
    const fault = helpCommand('fault', () => {
      throw new Error('step faulted');
    });
    const missingOutput = helpCommand('missing-output', () => ({ type: 'help' }));
    const externalWarning = helpCommand('external-warning', () => {
      throw new Error('external handler should not run in-process');
    });
    const info = vi.fn();
    const scope = new RunScope({
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      toolProvenance: [externalProvenance()],
    });

    const result = await runWithScope(scope, () =>
      runSuite({
        name: 'mixed',
        suite: {
          steps: [
            { tool: TOOL_ID, command: 'empty' },
            { tool: EXTERNAL_TOOL_ID, command: 'external-warning' },
            { tool: TOOL_ID, command: 'error' },
            { tool: TOOL_ID, command: 'failure-without-findings' },
            { tool: TOOL_ID, command: 'fault' },
            { tool: TOOL_ID, command: 'missing-output' },
          ],
        },
        tools: [
          tool(TOOL_ID, 'fitness', [empty, error, failureWithoutFindings, fault, missingOutput]),
          tool(EXTERNAL_TOOL_ID, 'external-fixture', [externalWarning]),
        ],
        ctx: makeDispatchHostCtx().ctx,
        suiteOpts: {},
      }),
    );

    expect(result.exitCode).toBe(2);
    expect(result.aggregate).toEqual({
      steps: 6,
      passed: 2,
      failed: 2,
      faulted: 1,
      errors: 2,
      warnings: 1,
    });
    expect(result.steps[0]).toMatchObject({
      command: 'empty',
      exitCode: EXIT_CODES.SUCCESS,
      verdict: { passed: true, errors: 0, warnings: 0, findings: 0 },
    });
    expect(result.steps[1]).toMatchObject({
      command: 'external-warning',
      exitCode: EXIT_CODES.SUCCESS,
      verdict: { passed: true, errors: 0, warnings: 1, findings: 1 },
    });
    expect(result.steps[2]).toMatchObject({
      command: 'error',
      exitCode: EXIT_CODES.RUNTIME_ERROR,
      verdict: { passed: false, errors: 2, warnings: 0, findings: 2 },
    });
    expect(result.steps[3]).toMatchObject({
      command: 'failure-without-findings',
      exitCode: 2,
    });
    expect(result.steps[3]?.verdict).toBeUndefined();
    expect(result.steps[4]).toMatchObject({
      command: 'fault',
      exitCode: EXIT_CODES.RUNTIME_ERROR,
      error: 'step faulted',
    });
    expect(result.steps[4]?.verdict).toBeUndefined();
    expect(result.steps[5]).toMatchObject({
      command: 'missing-output',
      exitCode: EXIT_CODES.SUCCESS,
    });
    expect(result.steps[5]?.verdict).toBeUndefined();

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.suite.run.complete',
        aggregate: result.aggregate,
      }),
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.suite.run.step',
        command: 'empty',
        verdict: { passed: true, findings: 0 },
      }),
    );
  });

  it('keeps suite orchestration output host-owned and summaries counts-only', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const secretMessage = 'SECRET_TOKEN_SHOULD_NOT_APPEAR';
    const secretPath = 'src/secret-token-location.ts';
    const secretEnvelope = signalEnvelope({
      passed: false,
      errors: 1,
      findings: 1,
      message: secretMessage,
      filePath: secretPath,
    });
    const spec = helpCommand('secret-finding', async (_opts, cli) => {
      await cli.deliverSignals(secretEnvelope, { cwd: '/repo' });
      return { type: 'help' };
    });

    try {
      const result = await runSuite({
        name: 'security',
        suite: { steps: [{ tool: TOOL_ID, command: 'secret-finding' }] },
        tools: [tool(TOOL_ID, 'fitness', [spec])],
        ctx: makeDispatchHostCtx().ctx,
        suiteOpts: {},
      });

      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        type: 'suite-run',
        suite: 'security',
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        aggregate: {
          steps: 1,
          passed: 0,
          failed: 1,
          faulted: 0,
          errors: 1,
          warnings: 0,
        },
      });
      expect(result.steps[0]).toEqual(
        expect.objectContaining({
          tool: 'fitness',
          stableId: TOOL_ID,
          command: 'secret-finding',
          exitCode: EXIT_CODES.RUNTIME_ERROR,
          durationMs: expect.any(Number),
          verdict: { passed: false, errors: 1, warnings: 0, findings: 1 },
        }),
      );
      expect(Object.keys(result.steps[0]?.verdict ?? {}).sort()).toEqual([
        'errors',
        'findings',
        'passed',
        'warnings',
      ]);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(secretMessage);
      expect(serialized).not.toContain(secretPath);
      expect(serialized).not.toContain('fixture-rule');
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe('deriveSuiteAggregate', () => {
  it('counts verdict, exit-only, faulted, and missing-output steps distinctly', () => {
    const steps: SuiteStepSummary[] = [
      {
        tool: 'fitness',
        stableId: TOOL_ID,
        command: 'pass',
        exitCode: EXIT_CODES.SUCCESS,
        durationMs: 1,
        verdict: { passed: true, errors: 0, warnings: 1, findings: 1 },
      },
      {
        tool: 'fitness',
        stableId: TOOL_ID,
        command: 'fail',
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        durationMs: 1,
        verdict: { passed: false, errors: 2, warnings: 0, findings: 2 },
      },
      {
        tool: 'fitness',
        stableId: TOOL_ID,
        command: 'exit-only',
        exitCode: 2,
        durationMs: 1,
      },
      {
        tool: 'fitness',
        stableId: TOOL_ID,
        command: 'fault',
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        durationMs: 1,
        error: 'boom',
      },
      {
        tool: 'fitness',
        stableId: TOOL_ID,
        command: 'missing-output',
        exitCode: EXIT_CODES.SUCCESS,
        durationMs: 1,
      },
    ];

    expect(deriveSuiteAggregate(steps)).toEqual({
      steps: 5,
      passed: 1,
      failed: 2,
      faulted: 1,
      errors: 2,
      warnings: 1,
    });
  });
});
