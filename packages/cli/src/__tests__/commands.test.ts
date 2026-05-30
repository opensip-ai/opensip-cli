/**
 * Tests for the CLI-owned command registration.
 *
 * `registerCliCommands` mounts the cross-tool housekeeping commands
 * (init, dashboard, sessions, configure, plugin, completion, uninstall)
 * onto a Commander program. The tests verify the full subcommand surface
 * exists with no duplicate or missing names — a drift test that catches
 * additions / removals at PR time.
 */

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerCliCommands } from '../commands/index.js';

import type { CommandResult } from '@opensip-tools/contracts';

function makeContext(): {
  setExitCode: ReturnType<typeof vi.fn>;
  render: (result: CommandResult) => Promise<void>;
  datastore: () => unknown;
} {
  return {
    setExitCode: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    datastore: () => undefined,
  };
}

function topLevelNames(program: Command): string[] {
  return program.commands.map((c) => c.name()).sort();
}

function subcommandNames(parent: Command, name: string): string[] {
  const child = parent.commands.find((c) => c.name() === name);
  if (!child) throw new Error(`No subcommand '${name}' on parent`);
  return child.commands.map((c) => c.name()).sort();
}

describe('registerCliCommands', () => {
  it('mounts every CLI-owned top-level command', () => {
    const program = new Command('opensip-tools');
    registerCliCommands(program, makeContext());

    expect(topLevelNames(program)).toEqual([
      'completion',
      'configure',
      'dashboard',
      'init',
      'plugin',
      'sessions',
      'uninstall',
    ]);
  });

  it('mounts the documented sessions subcommands', () => {
    const program = new Command('opensip-tools');
    registerCliCommands(program, makeContext());
    expect(subcommandNames(program, 'sessions')).toEqual(['list', 'purge']);
  });

  it('mounts the documented plugin subcommands', () => {
    const program = new Command('opensip-tools');
    registerCliCommands(program, makeContext());
    expect(subcommandNames(program, 'plugin')).toEqual(['add', 'list', 'remove', 'sync']);
  });

  it('does not mount any tool subcommands (those come via tool.register)', () => {
    const program = new Command('opensip-tools');
    registerCliCommands(program, makeContext());
    const names = topLevelNames(program);
    expect(names).not.toContain('fit');
    expect(names).not.toContain('sim');
    expect(names).not.toContain('graph');
  });
});
