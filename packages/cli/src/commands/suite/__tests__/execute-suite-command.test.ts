import {
  buildSignalEnvelope,
  type CommandOutcome,
  type SuiteRunResult,
} from '@opensip-cli/contracts';
import {
  defineCommand,
  HOST_VERDICT_POLICY_FALLBACK,
  RunScope,
  runWithScope,
  ToolRegistry,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeDispatchHostCtx } from '../../../__tests__/harness/dispatch-host-ctx.js';
import { executeSuiteCommand } from '../execute-suite-command.js';

import type { CliCommandsContext } from '../../shared.js';

const TOOL_ID = 'afd68bd3-ff3c-4935-a5b6-76d8fc7a5224';

function configuredCommandResultTool(): Tool {
  const spec = defineCommand<unknown, ToolCliContext>({
    name: 'inspect',
    description: 'Configured command-result fixture',
    commonFlags: ['json'],
    scope: 'project',
    output: 'command-result',
    producesVerdict: true,
    handler: (_opts, cli) => {
      cli.emitEnvelope(
        buildSignalEnvelope({
          tool: 'fixture',
          runId: 'step-run',
          createdAt: '2026-07-12T00:00:00.000Z',
          units: [{ slug: 'inspect', passed: true, durationMs: 1 }],
          signals: [],
          policy: HOST_VERDICT_POLICY_FALLBACK,
          runFaulted: false,
        }),
      );
      return { type: 'help' };
    },
  });
  return {
    identity: { name: 'fixture' },
    metadata: {
      id: TOOL_ID,
      name: 'fixture',
      version: '0.0.0',
      description: 'fixture',
    },
    commands: [{ name: spec.name, description: spec.description }],
    commandSpecs: [spec],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('executeSuiteCommand embedded output isolation', () => {
  it('emits only the parent result when a configured command-result step declares json', async () => {
    const tool = configuredCommandResultTool();
    const tools = new ToolRegistry();
    tools.register(tool);
    const scope = new RunScope({ tools });
    const host = makeDispatchHostCtx();
    const context = {
      setExitCode: host.ctx.setExitCode,
      getExitCode: host.ctx.getExitCode,
      render: host.ctx.render,
      emitJson: host.ctx.emitJson,
      emitRaw: host.ctx.emitRaw,
      emitError: host.ctx.emitError,
      pluginLayouts: [],
      toolScaffolds: [],
      datastore: () => undefined,
      toolContext: host.ctx,
      toolRunActionHooks: {},
    } as unknown as CliCommandsContext;
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const result = await runWithScope(scope, () =>
      executeSuiteCommand({
        name: 'configured-review',
        resolved: {
          source: 'configured',
          suite: { steps: [{ tool: TOOL_ID, command: 'inspect' }] },
        },
        opts: { json: true, full: true, cwd: process.cwd() },
        ctx: context,
        tools: [tool],
        defaultChanged: false,
      }),
    );

    expect(writes).toHaveLength(1);
    const output = JSON.parse(writes[0] ?? '') as CommandOutcome;
    expect(output.kind).toBe('suite-run');
    expect(output.data).toMatchObject({
      type: 'suite-run',
      suite: 'configured-review',
      steps: [expect.objectContaining({ command: 'inspect' })],
    });
    expect((output.data as SuiteRunResult).suiteRunId).toBe(result?.suiteRunId);
  });
});
