import { describe, expect, it, vi } from 'vitest';

import { defineNestedCommand, definePrimaryCommand } from '../command-spec-draft.js';
import { defineCommand } from '../command-spec-validate.js';
import { defineTool } from '../define-tool.js';
import { resolveToolCommandNames } from '../derive-commands-from-specs.js';

const noopHandler = vi.fn(async (): Promise<void> => {
  await Promise.resolve();
});

describe('defineTool', () => {
  it('derives commands[] and identity-derived fields from commandSpecs', () => {
    const tool = defineTool({
      identity: { name: 'demo', aliases: ['dm'], layoutKey: 'dmk' },
      metadata: {
        id: '00000000-0000-4000-8000-000000000001',
        version: '0.0.0',
        description: 'demo tool',
      },
      commandSpecs: [
        definePrimaryCommand({
          description: 'Run demo',
          commonFlags: ['json', 'cwd'],
          scope: 'project',
          output: 'signal-envelope',
          handler: noopHandler,
        }),
        defineNestedCommand({
          name: 'list',
          description: 'List demo',
          commonFlags: ['json', 'cwd'],
          scope: 'project',
          output: 'command-result',
          handler: noopHandler,
        }),
        defineCommand({
          name: 'demo-run-worker',
          description: 'Internal worker',
          visibility: 'internal',
          commonFlags: [],
          scope: 'project',
          output: 'raw-stream',
          rawStreamReason: 'worker-ipc',
          handler: noopHandler,
        }),
      ],
      pluginLayout: { userSubdirs: ['checks'] },
      extensionPoints: {
        initialize: noopHandler,
        sessionReplay: { replaySession: () => ({}) },
        config: { schema: {} },
      },
    });

    expect(tool.metadata.name).toBe('demo');
    expect(tool.identity.name).toBe('demo');
    expect(tool.commandSpecs?.[0]?.name).toBe('demo');
    expect(tool.commandSpecs?.[0]?.aliases).toEqual(['dm']);
    expect(tool.commandSpecs?.[1]?.parent).toBe('demo');
    expect(tool.pluginLayout?.domain).toBe('dmk');
    expect(tool.extensionPoints?.sessionReplay?.tool).toBe('dmk');
    expect(tool.extensionPoints?.config?.namespace).toBe('demo');
    expect(resolveToolCommandNames(tool)).toEqual(['demo', 'list', 'demo-run-worker']);
    expect(tool.commands?.map((c) => c.name)).toEqual(['demo', 'list', 'demo-run-worker']);
    expect(tool.extensionPoints?.initialize).toBeTypeOf('function');
  });

  it('throws when identity is missing', () => {
    try {
      defineTool({
        identity: undefined as never,
        metadata: {
          id: '00000000-0000-4000-8000-000000000002',
          version: '0.0.0',
          description: 'bad',
        },
        commandSpecs: [
          definePrimaryCommand({
            description: 'Run',
            commonFlags: [],
            scope: 'project',
            output: 'command-result',
            handler: noopHandler,
          }),
        ],
      });
      expect.fail('expected defineTool to throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('TOOL.IDENTITY.REQUIRED');
    }
  });

  it('rejects hand-written identity-derived extension fields', () => {
    const base = {
      identity: { name: 'demo' },
      metadata: {
        id: '00000000-0000-4000-8000-000000000003',
        version: '0.0.0',
        description: 'bad',
      },
      commandSpecs: [
        definePrimaryCommand({
          description: 'Run',
          commonFlags: [],
          scope: 'project',
          output: 'command-result',
          handler: noopHandler,
        }),
      ],
    } as const;

    expect(() =>
      defineTool({
        ...base,
        extensionPoints: {
          config: { schema: {}, namespace: 'manual' } as never,
        },
      }),
    ).toThrow(/config\.namespace/);
    expect(() =>
      defineTool({
        ...base,
        extensionPoints: {
          sessionReplay: { tool: 'manual', replaySession: () => ({}) } as never,
        },
      }),
    ).toThrow(/sessionReplay\.tool/);
    expect(() =>
      defineTool({
        ...base,
        pluginLayout: { domain: 'manual', userSubdirs: [] } as never,
      }),
    ).toThrow(/pluginLayout\.domain/);
  });

  it('accepts a hand-written primary command when aliases match identity exactly', () => {
    const tool = defineTool({
      identity: { name: 'demo', aliases: ['dm'] },
      metadata: {
        id: '00000000-0000-4000-8000-000000000007',
        version: '0.0.0',
        description: 'demo',
      },
      commandSpecs: [
        defineCommand({
          name: 'demo',
          aliases: ['dm'],
          description: 'Run',
          commonFlags: [],
          scope: 'project',
          output: 'command-result',
          handler: noopHandler,
        }),
      ],
      extensionPoints: {
        initialize: noopHandler,
        sessionReplay: { replaySession: () => ({}) },
      },
    });

    expect(tool.commandSpecs?.[0]?.aliases).toEqual(['dm']);
    expect(tool.extensionPoints?.config).toBeUndefined();
    expect(tool.extensionPoints?.sessionReplay?.tool).toBe('demo');
  });

  it('rejects command specs that drift from the declared identity', () => {
    expect(() =>
      defineTool({
        identity: { name: 'demo', aliases: ['d'] },
        metadata: {
          id: '00000000-0000-4000-8000-000000000004',
          version: '0.0.0',
          description: 'bad',
        },
        commandSpecs: [
          defineCommand({
            name: 'demo',
            aliases: ['wrong'],
            description: 'Run',
            commonFlags: [],
            scope: 'project',
            output: 'command-result',
            handler: noopHandler,
          }),
        ],
      }),
    ).toThrow(/aliases must match/);

    expect(() =>
      defineTool({
        identity: { name: 'demo' },
        metadata: {
          id: '00000000-0000-4000-8000-000000000005',
          version: '0.0.0',
          description: 'bad',
        },
        commandSpecs: [
          defineCommand({
            name: 'child',
            parent: 'other',
            description: 'Child',
            commonFlags: [],
            scope: 'project',
            output: 'command-result',
            handler: noopHandler,
          }),
        ],
      }),
    ).toThrow(/declares parent/);
  });

  it('requires exactly one primary command', () => {
    const metadata = {
      id: '00000000-0000-4000-8000-000000000006',
      version: '0.0.0',
      description: 'bad',
    };

    expect(() =>
      defineTool({
        identity: { name: 'demo' },
        metadata,
        commandSpecs: [
          defineNestedCommand({
            name: 'list',
            description: 'List',
            commonFlags: [],
            scope: 'project',
            output: 'command-result',
            handler: noopHandler,
          }),
        ],
      }),
    ).toThrow(/exactly one primary command/);

    expect(() =>
      defineTool({
        identity: { name: 'demo' },
        metadata,
        commandSpecs: [
          definePrimaryCommand({
            description: 'Run',
            commonFlags: [],
            scope: 'project',
            output: 'command-result',
            handler: noopHandler,
          }),
          defineCommand({
            name: 'demo',
            description: 'Run again',
            commonFlags: [],
            scope: 'project',
            output: 'command-result',
            handler: noopHandler,
          }),
        ],
      }),
    ).toThrow(/exactly one primary command/);
  });
});
