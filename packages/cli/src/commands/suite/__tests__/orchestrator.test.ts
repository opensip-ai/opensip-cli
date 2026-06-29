import { EXIT_CODES } from '@opensip-cli/contracts';
import { defineCommand, type Tool, type ToolCliContext } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { makeDispatchHostCtx } from '../../../__tests__/harness/dispatch-host-ctx.js';
import { runSuite } from '../orchestrator.js';

const TOOL_ID = '00000000-0000-4000-8000-000000000111';
const OTHER_TOOL_ID = '00000000-0000-4000-8000-000000000222';

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
});
