import { describe, expect, it, vi } from 'vitest';

import { defineNestedCommand, definePrimaryCommand } from '../command-spec-draft.js';
import { createTool } from '../create-tool.js';
import { defineTool } from '../define-tool.js';
import { resolveToolCommandNames } from '../derive-commands-from-specs.js';
import { TOOL_CONTRACT_VERSION } from '../types.js';

const noopHandler = vi.fn(async (): Promise<void> => {
  await Promise.resolve();
});
const replaySession = () => ({});

const baseIdentity = { name: 'demo', aliases: ['dm'], layoutKey: 'dmk' };
const baseMetadata = {
  id: '00000000-0000-4000-8000-000000000001',
  version: '0.0.0',
  description: 'demo tool',
};

describe('createTool', () => {
  it('derives the same tool shape as an equivalent defineTool call', () => {
    const primary = {
      description: 'Run demo',
      commonFlags: ['json', 'cwd'] as const,
      scope: 'project' as const,
      output: 'signal-envelope' as const,
      handler: noopHandler,
    };
    const list = {
      name: 'list',
      description: 'List demo',
      commonFlags: ['json', 'cwd'] as const,
      scope: 'project' as const,
      output: 'command-result' as const,
      handler: noopHandler,
    };

    const viaCreate = createTool({
      identity: baseIdentity,
      metadata: baseMetadata,
      primaryCommand: primary,
      subcommands: [list],
      pluginLayout: { userSubdirs: ['checks'] },
      extensionPoints: {
        initialize: noopHandler,
        sessionReplay: { replaySession },
        config: { schema: {} },
      },
    });

    const viaDefine = defineTool({
      identity: baseIdentity,
      metadata: baseMetadata,
      commandSpecs: [definePrimaryCommand(primary), defineNestedCommand(list)],
      pluginLayout: { userSubdirs: ['checks'] },
      extensionPoints: {
        initialize: noopHandler,
        sessionReplay: { replaySession },
        config: { schema: {} },
      },
      contractVersion: TOOL_CONTRACT_VERSION,
    });

    expect(viaCreate.metadata.name).toBe(viaDefine.metadata.name);
    expect(viaCreate.identity).toEqual(viaDefine.identity);
    expect(resolveToolCommandNames(viaCreate)).toEqual(resolveToolCommandNames(viaDefine));
    expect(viaCreate.commandSpecs?.map((spec) => spec.name)).toEqual(
      viaDefine.commandSpecs?.map((spec) => spec.name),
    );
    expect(viaCreate.commandSpecs?.[0]?.aliases).toEqual(viaDefine.commandSpecs?.[0]?.aliases);
    expect(viaCreate.commandSpecs?.[1]?.parent).toBe(viaDefine.commandSpecs?.[1]?.parent);
    expect(viaCreate.pluginLayout).toEqual(viaDefine.pluginLayout);
    expect(viaCreate.extensionPoints).toEqual(viaDefine.extensionPoints);
    expect(viaCreate.contractVersion).toBe(TOOL_CONTRACT_VERSION);
  });

  it('defaults core contractVersion and omits extensionPoints when none supplied', () => {
    const tool = createTool({
      identity: { name: 'plain' },
      metadata: {
        id: '00000000-0000-4000-8000-000000000002',
        version: '0.1.0',
        description: 'plain tool',
      },
      primaryCommand: {
        description: 'Run plain',
        commonFlags: [],
        scope: 'none',
        output: 'command-result',
        handler: noopHandler,
      },
    });

    expect(tool.contractVersion).toBe(TOOL_CONTRACT_VERSION);
    expect(tool.extensionPoints).toBeUndefined();
  });

  it('passes explicit extension points through to defineTool', () => {
    const tool = createTool({
      identity: { name: 'hooks' },
      metadata: {
        id: '00000000-0000-4000-8000-000000000003',
        version: '0.1.0',
        description: 'hooks tool',
      },
      primaryCommand: {
        description: 'Run hooks',
        commonFlags: [],
        scope: 'none',
        output: 'command-result',
        handler: noopHandler,
      },
      extensionPoints: {
        initialize: noopHandler,
        config: { schema: {} },
      },
      contractVersion: '9.9.9',
    });

    expect(tool.extensionPoints?.initialize).toBeTypeOf('function');
    expect(tool.extensionPoints?.config?.namespace).toBe('hooks');
    expect(tool.contractVersion).toBe('9.9.9');
  });

  it('surfaces defineTool validation failures for forbidden derived fields', () => {
    try {
      createTool({
        identity: { name: 'demo' },
        metadata: {
          id: '00000000-0000-4000-8000-000000000004',
          version: '0.1.0',
          description: 'bad',
        },
        primaryCommand: {
          description: 'Run',
          commonFlags: [],
          scope: 'none',
          output: 'command-result',
          handler: noopHandler,
        },
        extensionPoints: {
          config: { namespace: 'hand-written', schema: {} },
        } as never,
      });
      expect.fail('expected createTool to throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('TOOL.IDENTITY.NAMESPACE_FORBIDDEN');
    }
  });
});
