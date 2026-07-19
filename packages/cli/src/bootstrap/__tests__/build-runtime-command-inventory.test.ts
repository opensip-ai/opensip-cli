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
import {
  buildRuntimeCommandInventory,
  type BuildRuntimeCommandInventoryInput,
} from '../build-runtime-command-inventory.js';

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

function emptyInput(
  overrides: Partial<BuildRuntimeCommandInventoryInput> = {},
): BuildRuntimeCommandInventoryInput {
  return {
    toolRegistry: new ToolRegistry(),
    toolCommandSpecs: [],
    hostSpecs: [],
    hostGroups: [],
    toolPluginGroups: [],
    ...overrides,
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

  it('projects extra mounted tool specs with matched and fallback ownership', () => {
    const registry = new ToolRegistry();
    const registered = tool();
    (
      registered as { commandSpecs?: readonly CommandSpec<unknown, ToolCliContext>[] }
    ).commandSpecs = [];
    registry.register(registered);

    const inventory = buildRuntimeCommandInventory(
      emptyInput({
        toolRegistry: registry,
        toolCommandSpecs: [
          toolSpec('alpha'),
          toolSpec('inspect', 'alpha'),
          toolSpec('inspect', 'missing'),
          toolSpec('standalone'),
        ],
        provenance: [
          {
            source: 'bundled',
            id: 'alpha',
            version: '1.0.0',
            manifestHash: 'without-package-name',
          },
        ],
      }),
    );

    expect(
      inventory.leaves.map(({ path, ownerLabel, provenanceSource, packageIdentity }) => ({
        path,
        ownerLabel,
        provenanceSource,
        packageIdentity,
      })),
    ).toEqual([
      {
        path: 'alpha',
        ownerLabel: 'alpha',
        provenanceSource: 'bundled',
        packageIdentity: undefined,
      },
      {
        path: 'alpha inspect',
        ownerLabel: 'alpha',
        provenanceSource: 'bundled',
        packageIdentity: undefined,
      },
      {
        path: 'missing inspect',
        ownerLabel: 'missing',
        provenanceSource: undefined,
        packageIdentity: undefined,
      },
      {
        path: 'standalone',
        ownerLabel: 'standalone',
        provenanceSource: undefined,
        packageIdentity: undefined,
      },
    ]);
  });

  it('ignores malformed extra mount entries and registry-covered duplicates', () => {
    const registry = new ToolRegistry();
    registry.register(tool());

    const inventory = buildRuntimeCommandInventory(
      emptyInput({
        toolRegistry: registry,
        toolCommandSpecs: [
          null as unknown as object,
          {},
          toolSpec('alpha'),
          toolSpec('list', 'alpha'),
        ],
      }),
    );

    expect(inventory.leaves.map((leaf) => leaf.path)).toEqual(['alpha', 'alpha list']);
  });

  it('projects only plain alias entries and applies scope and visibility defaults', () => {
    const aliases = ['short', '', 7, 'also-short'] as unknown[];
    Object.defineProperty(aliases, '2', {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error('alias accessor must not run');
      },
    });
    const rawSpec = {
      name: 'status',
      output: 'command-result',
      visibility: 'internal',
      aliases,
      handler,
    };

    const inventory = buildRuntimeCommandInventory(emptyInput({ hostSpecs: [rawSpec] }));

    expect(inventory.leaves).toEqual([
      expect.objectContaining({
        path: 'status',
        aliases: ['short', 'also-short'],
        scope: 'project',
        visibility: 'internal',
      }),
    ]);
  });

  it.each([
    {
      name: 'an invalid host entry',
      input: () => emptyInput({ hostSpecs: [null as unknown as object] }),
      message: /invalid host command spec/,
    },
    {
      name: 'a host entry without a name',
      input: () => emptyInput({ hostSpecs: [{}] }),
      message: /host command missing name/,
    },
    {
      name: 'a leaf without output',
      input: () => emptyInput({ hostSpecs: [{ name: 'status', handler }] }),
      message: /missing output/,
    },
    {
      name: 'a leaf without a data handler',
      input: () =>
        emptyInput({
          hostSpecs: [{ name: 'status', output: 'command-result' }],
        }),
      message: /handler missing or accessor/,
    },
    {
      name: 'an accessor static handler',
      input: () => {
        const spec = { name: 'status', output: 'command-result', handler };
        Object.defineProperty(spec, 'staticHandler', {
          get: () => {
            throw new Error('static handler accessor must not run');
          },
        });
        return emptyInput({ hostSpecs: [spec] });
      },
      message: /staticHandler must be own data plain object/,
    },
    {
      name: 'an incomplete static handler',
      input: () =>
        emptyInput({
          hostSpecs: [
            {
              name: 'status',
              output: 'command-result',
              staticHandler: { package: 'opensip-cli', path: 'status.ts' },
              handler,
            },
          ],
        }),
      message: /staticHandler missing package\/path\/declaration/,
    },
    {
      name: 'a hostile property descriptor',
      input: () =>
        emptyInput({
          hostSpecs: [
            new Proxy(
              {},
              {
                getOwnPropertyDescriptor: () => {
                  throw new Error('descriptor trap');
                },
              },
            ),
          ],
        }),
      message: /host command missing name/,
    },
    {
      name: 'a command whose name changes between validation and projection',
      input: () => {
        let nameReads = 0;
        const spec = new Proxy(
          { output: 'command-result', handler },
          {
            getOwnPropertyDescriptor: (target, key) => {
              if (key !== 'name') return Reflect.getOwnPropertyDescriptor(target, key);
              nameReads++;
              return nameReads === 1
                ? {
                    configurable: true,
                    enumerable: true,
                    value: 'status',
                    writable: false,
                  }
                : undefined;
            },
          },
        );
        return emptyInput({ hostSpecs: [spec] });
      },
      message: /command at 'status' missing name/,
    },
  ])('rejects $name fail-closed', ({ input, message }) => {
    expect(() => buildRuntimeCommandInventory(input())).toThrow(message);
  });

  it('rejects malformed registry command specs before projection', () => {
    const invalidEntryRegistry = new ToolRegistry();
    const invalidEntryTool = tool();
    (invalidEntryTool as unknown as { commandSpecs: readonly unknown[] }).commandSpecs = [null];
    invalidEntryRegistry.register(invalidEntryTool);
    expect(() =>
      buildRuntimeCommandInventory(emptyInput({ toolRegistry: invalidEntryRegistry })),
    ).toThrow(/invalid commandSpecs entry/);

    const missingNameRegistry = new ToolRegistry();
    const missingNameTool = tool();
    (missingNameTool as unknown as { commandSpecs: readonly unknown[] }).commandSpecs = [{}];
    missingNameRegistry.register(missingNameTool);
    expect(() =>
      buildRuntimeCommandInventory(emptyInput({ toolRegistry: missingNameRegistry })),
    ).toThrow(/command missing name/);
  });

  it('rejects unnamed host-group and plugin-group leaves', () => {
    expect(() =>
      buildRuntimeCommandInventory(
        emptyInput({
          hostGroups: [{ name: 'sessions', description: 'sessions', leaves: [{}] } as never],
        }),
      ),
    ).toThrow(/host group 'sessions' leaf missing name/);

    expect(() =>
      buildRuntimeCommandInventory(
        emptyInput({
          toolPluginGroups: [
            {
              parentVerb: 'alpha',
              parentAliases: [],
              toolVerb: 'alpha',
              domain: 'alpha',
              description: 'plugins',
              leaves: [{}],
            } as never,
          ],
        }),
      ),
    ).toThrow(/plugin group 'alpha plugin' leaf missing name/);
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
