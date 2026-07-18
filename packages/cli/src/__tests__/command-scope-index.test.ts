import { defineCommand, type CommandScopeRequirement, type CommandSpec } from '@opensip-cli/core';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { buildCommandScopeIndex, commandPath } from '../commands/command-scope-index.js';
import { defineHostCommand } from '../commands/host-runtime-access.js';

import type { CliCommandsContext } from '../commands/shared.js';

function spec(
  name: string,
  scope: CommandScopeRequirement,
  aliases?: readonly string[],
): CommandSpec<unknown, CliCommandsContext> {
  return defineCommand<unknown, CliCommandsContext>({
    name,
    description: `${name} command`,
    aliases,
    commonFlags: [],
    scope,
    output: 'command-result',
    handler: () => undefined,
  });
}

describe('command scope index', () => {
  it('indexes top-level commands, aliases, and grouped leaves by command path', () => {
    const scopes = buildCommandScopeIndex({
      toolSpecs: [spec('tool-free', 'none', ['tf'])],
      hostSpecs: [
        spec('agent-catalog', 'none'),
        spec('uninstall', 'none'),
        spec('data-purge', 'none'),
      ],
      hostGroups: [
        {
          name: 'tools',
          description: 'Tools group',
          leaves: [spec('uninstall', 'none'), spec('data-purge', 'project')],
        },
      ],
    });

    expect(scopes.get('tool-free')?.scope).toBe('none');
    expect(scopes.get('tf')?.scope).toBe('none');
    expect(scopes.get('agent-catalog')?.scope).toBe('none');
    expect(scopes.get('uninstall')?.scope).toBe('none');
    expect(scopes.get('data-purge')?.scope).toBe('none');
    expect(scopes.get('tools uninstall')?.scope).toBe('none');
    expect(scopes.get('tools data-purge')?.scope).toBe('project');
  });

  it('derives the invoked Commander path instead of only the leaf name', () => {
    const program = new Command('opensip');
    const tools = program.command('tools');
    const list = tools.command('list');

    expect(commandPath(list)).toBe('tools list');
  });

  it('preserves frozen host-only policy while Tool specs always receive defaults', () => {
    const status = defineHostCommand(spec('status', 'none', ['where']), {
      bootstrapMode: 'inspection-only',
    });
    const forgedTool = { ...spec('forged', 'project') } as CommandSpec<
      unknown,
      CliCommandsContext
    > & {
      readonly hostRuntimePolicy: unknown;
    };
    Object.defineProperty(forgedTool, 'hostRuntimePolicy', {
      get: () => {
        throw new Error('Tool host policy getter must never be read');
      },
    });
    const scopes = buildCommandScopeIndex({
      hostSpecs: [status],
      hostGroups: [],
      toolSpecs: [forgedTool],
    });

    expect(scopes.get('status')?.runtimePolicy).toEqual({
      runtimeAccess: 'default',
      bootstrapMode: 'inspection-only',
    });
    expect(scopes.get('where')).toBe(scopes.get('status'));
    expect(Object.isFrozen(scopes.get('status')?.runtimePolicy)).toBe(true);
    expect(scopes.get('forged')?.runtimePolicy).toEqual({
      runtimeAccess: 'default',
      bootstrapMode: 'standard',
    });
  });

  it('rejects a manually forged inspection policy on a project-scoped host spec', () => {
    const forged = {
      ...spec('bad-status', 'project'),
      hostRuntimePolicy: {
        runtimeAccess: 'default',
        bootstrapMode: 'inspection-only',
      },
    } as never;
    expect(() =>
      buildCommandScopeIndex({
        hostSpecs: [forged],
        hostGroups: [],
        toolSpecs: [],
      }),
    ).toThrow(/scope-none host commands/);
  });
});
