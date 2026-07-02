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

const TOOL_ID = 'afd68bd3-ff3c-4935-a5b6-76d8fc7a5224';
const GRAPH_ID = '3873f1c2-02a9-4719-930a-bca74b62b706';
const YAGNI_ID = '3aba9195-2297-4f20-99d5-906945092dfc';

function command(name: string, options: NonNullable<Tool['commandSpecs']>[number]['options'] = []) {
  return defineCommand<unknown, ToolCliContext>({
    name,
    description: 'fixture',
    commonFlags: [],
    options,
    scope: 'project',
    output: 'command-result',
    producesVerdict: true,
    handler: () => ({ type: 'help' }),
  });
}

function fixtureTool(
  id = TOOL_ID,
  name = 'fitness',
  specs: Tool['commandSpecs'] = [
    command('fitness', [
      { flag: '--recipe', value: '<name>', description: 'recipe' },
      { flag: '--changed', description: 'changed', default: false },
      { flag: '--since', value: '<ref>', description: 'since' },
    ]),
    command('fit', [
      { flag: '--recipe', value: '<name>', description: 'recipe' },
      { flag: '--changed', description: 'changed', default: false },
      { flag: '--since', value: '<ref>', description: 'since' },
    ]),
  ],
): Tool {
  return {
    metadata: {
      id,
      name,
      version: '0.0.0',
      description: 'fixture',
    },
    commands: (specs ?? []).map((spec) => ({
      name: spec.name,
      description: spec.description,
    })),
    commandSpecs: specs,
  };
}

function auditTools(): readonly Tool[] {
  return [
    fixtureTool(),
    fixtureTool(GRAPH_ID, 'graph', [
      command('impact', [
        { flag: '--changed', description: 'changed', default: false },
        { flag: '--since', value: '<ref>', description: 'since' },
        {
          flag: '--files',
          value: '<path>',
          description: 'files',
          arrayDefault: [],
          parse: (raw, prev) => [...(Array.isArray(prev) ? prev : []), raw],
        },
      ]),
    ]),
    fixtureTool(YAGNI_ID, 'yagni', [
      command('yagni', [
        {
          flag: '--min-confidence',
          value: '<level>',
          description: 'confidence',
          choices: ['low', 'medium', 'high'],
        },
      ]),
    ]),
  ];
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

function hostCtx(toolContext?: ToolCliContext, toolRunActionHooks = {}) {
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
    toolRunActionHooks,
    exitCodes,
  };
}

function withSuiteScope<T>(
  fn: () => Promise<T> | T,
  suites?: Record<string, unknown>,
  toolsInput: readonly Tool[] = auditTools(),
): Promise<T> {
  const resolvedSuites = suites ?? {
    security: {
      description: 'Security suite',
      steps: [{ tool: TOOL_ID, command: 'fit', args: {} }],
    },
  };
  const tools = new ToolRegistry();
  for (const tool of toolsInput) tools.register(tool);
  const scope = new RunScope({
    tools,
    languages: new LanguageRegistry(),
  });
  Object.assign(scope, {
    configDocument: { suites: resolvedSuites },
    projectContext: {
      projectRoot: tmp,
      configPath: join(tmp, 'opensip-cli.config.yml'),
    },
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
      expect.objectContaining({
        name: 'security',
        ctx: host.ctx,
        runActionHooks: {},
        defaultChanged: false,
      }),
    );
    expect(ctx.exitCodes).toContain(0);
  });

  it('runs the built-in audit suite when no configured audit suite exists', async () => {
    const host = makeDispatchHostCtx();
    const ctx = hostCtx(host.ctx);
    const [runSpec] = buildSuiteGroupLeaves(ctx);

    await withSuiteScope(() => runSpec.handler?.({ _args: ['audit'] }, ctx), {});

    expect(runSuiteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'audit',
        defaultChanged: true,
        suite: expect.objectContaining({
          steps: [
            expect.objectContaining({
              tool: TOOL_ID,
              command: 'fitness',
              args: { recipe: 'agent-risk' },
            }),
            expect.objectContaining({
              tool: GRAPH_ID,
              command: 'impact',
              args: {},
            }),
            expect.objectContaining({
              tool: YAGNI_ID,
              command: 'yagni',
              args: { minConfidence: 'high' },
            }),
          ],
        }),
      }),
    );
  });

  it('lets configured audit override the built-in suite', async () => {
    const host = makeDispatchHostCtx();
    const ctx = hostCtx(host.ctx);
    const [runSpec] = buildSuiteGroupLeaves(ctx);

    await withSuiteScope(() => runSpec.handler?.({ _args: ['audit'] }, ctx), {
      audit: {
        description: 'Custom audit',
        steps: [{ tool: TOOL_ID, command: 'fit', args: { recipe: 'custom' } }],
      },
    });

    expect(runSuiteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'audit',
        defaultChanged: false,
        suite: {
          description: 'Custom audit',
          steps: [{ tool: TOOL_ID, command: 'fit', args: { recipe: 'custom' } }],
        },
      }),
    );
  });

  it('lists configured suites with resolved steps', async () => {
    const ctx = hostCtx();
    const [, listSpec] = buildSuiteGroupLeaves(ctx);

    const result = await withSuiteScope(() => listSpec.handler?.({}, ctx));

    expect(result).toEqual({
      type: 'suite-list',
      totalCount: 2,
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
        {
          name: 'audit',
          description:
            'PR-review workflow: changed-code risk, graph impact, and high-confidence reduction candidates',
          steps: [
            {
              tool: 'fitness',
              stableId: TOOL_ID,
              command: 'fitness',
              args: { recipe: 'agent-risk' },
            },
            {
              tool: 'graph',
              stableId: GRAPH_ID,
              command: 'impact',
              args: {},
            },
            {
              tool: 'yagni',
              stableId: YAGNI_ID,
              command: 'yagni',
              args: { minConfidence: 'high' },
            },
          ],
        },
      ],
    });
  });

  it('lists configured audit instead of the built-in audit suite', async () => {
    const ctx = hostCtx();
    const [, listSpec] = buildSuiteGroupLeaves(ctx);

    const result = await withSuiteScope(() => listSpec.handler?.({}, ctx), {
      audit: {
        description: 'Custom audit',
        steps: [{ tool: TOOL_ID, command: 'fit', args: { recipe: 'custom' } }],
      },
    });

    expect(result).toEqual({
      type: 'suite-list',
      totalCount: 1,
      suites: [
        {
          name: 'audit',
          description: 'Custom audit',
          steps: [
            {
              tool: 'fitness',
              stableId: TOOL_ID,
              command: 'fit',
              args: { recipe: 'custom' },
            },
          ],
        },
      ],
    });
  });

  it('declares suite workflow flags but not suite-level sarif', () => {
    const [runSpec] = buildSuiteGroupLeaves(hostCtx());
    const flags = new Set(runSpec.options?.map((option) => option.flag));

    expect(flags.has('--changed')).toBe(true);
    expect(flags.has('--since')).toBe(true);
    expect(flags.has('--files')).toBe(true);
    expect(flags.has('--sarif')).toBe(false);
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
