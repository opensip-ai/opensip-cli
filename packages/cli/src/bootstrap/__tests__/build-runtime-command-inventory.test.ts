import {
  createRuntimeCommandInventory,
  defineCommand,
  ToolRegistry,
  type CommandSpec,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { defineHostCommand } from '../../commands/host-runtime-access.js';
import { buildRuntimeCommandInventory } from '../build-runtime-command-inventory.js';

function handler(): undefined {
  return undefined;
}

function toolSpec(name: string, parent?: string): CommandSpec<unknown, ToolCliContext> {
  return defineCommand({
    name,
    description: 'fixture',
    commonFlags: [],
    scope: 'project',
    output: 'command-result',
    ...(parent === undefined ? {} : { parent }),
    staticHandler: {
      package: '@fixture/alpha',
      path: 'packages/alpha/src/cmd.ts',
      declaration: 'handler',
    },
    handler,
  });
}

function tool(): Tool {
  return {
    identity: { name: 'alpha', aliases: [] },
    metadata: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'alpha',
      version: '1.0.0',
      description: 'fixture',
    },
    commandSpecs: [toolSpec('alpha'), toolSpec('list', 'alpha')],
  };
}

describe('buildRuntimeCommandInventory', () => {
  it('projects tool leaves, host leaves, groups, and plugin paths once', () => {
    const registry = new ToolRegistry();
    registry.register(tool());
    const hostSpec = defineCommand({
      name: 'init',
      description: 'init',
      commonFlags: [],
      scope: 'none',
      output: 'command-result',
      staticHandler: {
        package: 'opensip-cli',
        path: 'packages/cli/src/commands/host-command-specs.ts',
        declaration: 'buildInitSpec',
      },
      handler,
    });
    const inv = buildRuntimeCommandInventory({
      toolRegistry: registry,
      toolCommandSpecs: registry.list().flatMap((t) => t.commandSpecs ?? []),
      hostSpecs: [hostSpec],
      hostGroups: [
        {
          name: 'sessions',
          description: 'sessions',
          leaves: [
            defineCommand({
              name: 'list',
              description: 'list sessions',
              commonFlags: [],
              scope: 'project',
              output: 'command-result',
              staticHandler: {
                package: 'opensip-cli',
                path: 'packages/cli/src/commands/host-subcommand-sessions.ts',
                declaration: 'buildSessionsListSpec',
              },
              handler,
            }),
          ],
        },
      ],
      toolPluginGroups: [
        {
          parentVerb: 'alpha',
          parentAliases: [],
          toolVerb: 'alpha',
          domain: 'alpha',
          description: 'plugins',
          leaves: [
            defineCommand({
              name: 'list',
              description: 'list packs',
              commonFlags: [],
              scope: 'project',
              output: 'command-result',
              staticHandler: {
                package: 'opensip-cli',
                path: 'packages/cli/src/commands/host-subcommand-plugins.ts',
                declaration: 'buildPluginListSpec',
              },
              handler,
            }),
          ],
        },
      ],
      provenance: [
        {
          source: 'bundled',
          id: 'alpha',
          stableId: '11111111-1111-4111-8111-111111111111',
          version: '1.0.0',
          packageName: '@fixture/alpha',
          resolvedPath: '/x',
          manifestHash: 'h',
        },
      ],
    });

    expect(inv.complete).toBe(true);
    const paths = inv.leaves.map((l) => l.path).sort();
    expect(paths).toEqual(['alpha', 'alpha list', 'alpha plugin list', 'init', 'sessions list']);
    expect(inv.groups.map((g) => g.path).sort()).toEqual(['alpha plugin', 'sessions']);
    expect(inv.leaves.every((l) => l.staticHandler !== undefined)).toBe(true);
    expect(inv.leaves.find((l) => l.path === 'alpha')?.packageIdentity).toBe('@fixture/alpha');
    expect(inv.leaves.find((l) => l.path === 'init')?.owner).toBe('host');
  });

  it('rejects duplicate canonical paths fail-closed', () => {
    const registry = new ToolRegistry();
    registry.register(tool());
    const host = defineCommand({
      name: 'alpha',
      description: 'collision',
      commonFlags: [],
      scope: 'none',
      output: 'command-result',
      staticHandler: {
        package: 'opensip-cli',
        path: 'packages/cli/src/commands/host-command-specs.ts',
        declaration: 'handler',
      },
      handler,
    });
    expect(() =>
      buildRuntimeCommandInventory({
        toolRegistry: registry,
        toolCommandSpecs: [],
        hostSpecs: [host],
        hostGroups: [],
        toolPluginGroups: [],
      }),
    ).toThrow(/duplicate path/);
  });

  it('createRuntimeCommandInventory freezes leaves', () => {
    const inv = createRuntimeCommandInventory({
      leaves: [
        {
          path: 'x',
          name: 'x',
          aliases: [],
          owner: 'host',
          ownerLabel: 'cli',
          visibility: 'public',
          scope: 'none',
          output: 'command-result',
        },
      ],
    });
    expect(Object.isFrozen(inv)).toBe(true);
    expect(Object.isFrozen(inv.leaves[0])).toBe(true);
  });

  it('omits CLI-private host runtime policy from the public inventory', () => {
    const registry = new ToolRegistry();
    const status = defineHostCommand(
      {
        name: 'status',
        description: 'status',
        commonFlags: [],
        scope: 'none',
        output: 'command-result',
        handler,
      },
      { bootstrapMode: 'inspection-only' },
    );
    const inv = buildRuntimeCommandInventory({
      toolRegistry: registry,
      toolCommandSpecs: [],
      hostSpecs: [status],
      hostGroups: [],
      toolPluginGroups: [],
    });
    const serialized = JSON.stringify(inv);
    expect(serialized).not.toContain('hostRuntimePolicy');
    expect(serialized).not.toContain('inspection-only');
    expect(inv.leaves.find((leaf) => leaf.path === 'status')).toMatchObject({
      owner: 'host',
      scope: 'none',
    });
  });
});
