import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  defineCommand,
  LanguageRegistry,
  RunScope,
  runWithScope,
  ToolRegistry,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeDispatchHostCtx } from '../../../__tests__/harness/dispatch-host-ctx.js';
import { buildSuiteGroupLeaves } from '../suite-command-specs.js';

const runSuiteMock = vi.hoisted(() => vi.fn());

vi.mock('../orchestrator.js', () => ({
  runSuite: runSuiteMock,
}));

const TOOL_ID = '00000000-0000-4000-8000-000000000501';

function fixtureTool(): Tool {
  return {
    metadata: {
      id: TOOL_ID,
      name: 'fitness',
      version: '0.0.0',
      description: 'fixture',
    },
    commands: [{ name: 'fit', description: 'fixture' }],
    commandSpecs: [
      defineCommand<unknown, ToolCliContext>({
        name: 'fit',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'command-result',
        handler: () => ({ type: 'help' }),
      }),
    ],
  };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'suite-specs-'));
  runSuiteMock.mockReset();
  runSuiteMock.mockResolvedValue({
    type: 'suite-run',
    suite: 'security',
    suiteRunId: 'run-1',
    exitCode: 0,
    durationMs: 10,
    steps: [],
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function hostCtx(toolContext?: ToolCliContext) {
  const exitCodes: number[] = [];
  return {
    setExitCode: (code: number) => {
      exitCodes.push(code);
    },
    render: vi.fn(() => Promise.resolve()),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitError: vi.fn(),
    pluginLayouts: [],
    toolScaffolds: [],
    datastore: () => {
      throw new Error('not used');
    },
    toolContext,
    exitCodes,
  };
}

function withSuiteScope<T>(fn: () => Promise<T> | T, suites?: Record<string, unknown>): Promise<T> {
  const resolvedSuites = suites ?? {
    security: {
      description: 'Security suite',
      steps: [{ tool: TOOL_ID, command: 'fit', args: {} }],
    },
  };
  const tools = new ToolRegistry();
  tools.register(fixtureTool());
  const scope = new RunScope({
    tools,
    languages: new LanguageRegistry(),
  });
  Object.assign(scope, {
    configDocument: { suites: resolvedSuites },
    projectContext: { projectRoot: tmp, configPath: join(tmp, 'opensip-cli.config.yml') },
  });
  return runWithScope(scope, fn);
}

describe('buildSuiteGroupLeaves', () => {
  it('returns configuration errors when suite run lacks toolContext', async () => {
    const ctx = hostCtx();
    const [runSpec] = buildSuiteGroupLeaves(ctx);

    const result = await runSpec.handler?.({ _args: ['security'] }, ctx);

    expect(result).toEqual({
      type: 'error',
      message: 'suite run requires the full ToolCliContext handle.',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
    expect(ctx.exitCodes).toContain(EXIT_CODES.CONFIGURATION_ERROR);
  });

  it('runs a configured suite and propagates the orchestrator exit code', async () => {
    const host = makeDispatchHostCtx();
    const ctx = hostCtx(host.ctx);
    const [runSpec] = buildSuiteGroupLeaves(ctx);

    await withSuiteScope(() => runSpec.handler?.({ _args: ['security'] }, ctx));

    expect(runSuiteMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'security', ctx: host.ctx }),
    );
    expect(ctx.exitCodes).toContain(0);
  });

  it('lists configured suites with resolved steps', async () => {
    const ctx = hostCtx();
    const [, listSpec] = buildSuiteGroupLeaves(ctx);

    const result = await withSuiteScope(() => listSpec.handler?.({}, ctx));

    expect(result).toEqual({
      type: 'suite-list',
      totalCount: 1,
      suites: [
        {
          name: 'security',
          description: 'Security suite',
          steps: [
            {
              tool: 'fitness',
              stableId: TOOL_ID,
              command: 'fit',
              args: {},
            },
          ],
        },
      ],
    });
  });

  it('adds a suite step and leaves exit code unchanged when the file is already up to date', async () => {
    const ctx = hostCtx();
    const addSpec = buildSuiteGroupLeaves(ctx)[2];

    await withSuiteScope(async () => {
      const first = await addSpec.handler?.(
        {
          _args: ['security'],
          tool: 'fitness',
          command: 'fit',
          arg: ['recipe=security'],
        },
        ctx,
      );
      const second = await addSpec.handler?.(
        {
          _args: ['security'],
          tool: 'fitness',
          command: 'fit',
          arg: ['recipe=security'],
        },
        ctx,
      );

      expect(first).toEqual(
        expect.objectContaining({
          type: 'suite-add',
          suite: 'security',
          changed: true,
        }),
      );
      expect(second).toEqual(
        expect.objectContaining({
          type: 'suite-add',
          changed: false,
        }),
      );
      expect(ctx.exitCodes.at(-1)).toBe(EXIT_CODES.SUCCESS);
    });
  });

  it('reports unknown suites on run', async () => {
    const host = makeDispatchHostCtx();
    const ctx = hostCtx(host.ctx);
    const [runSpec] = buildSuiteGroupLeaves(ctx);

    const result = await withSuiteScope(() => runSpec.handler?.({ _args: ['missing'] }, ctx));

    expect(result).toEqual({
      type: 'error',
      message: "Unknown suite 'missing'.",
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
  });
});
