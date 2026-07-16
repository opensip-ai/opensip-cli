import { defineCommand, type CommandScopeRequirement, type CommandSpec } from '@opensip-cli/core';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { buildCommandScopeIndex, commandPath } from '../commands/command-scope-index.js';

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
});
