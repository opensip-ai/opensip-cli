/**
 * Tests for the CLI-owned command registration.
 *
 * `registerCliCommands` mounts the cross-tool housekeeping commands
 * (init, report, sessions, configure, completion, uninstall, tools) onto a
 * Commander program. The pack-management `plugin {add,list,remove,sync}` ops
 * are NO LONGER a top-level group — they mount UNDER each pack-supporting tool
 * primary (`opensip fit plugin …`). The tests verify the full subcommand
 * surface exists with no duplicate or missing names — a drift test that catches
 * additions / removals at PR time.
 */

import { ToolRegistry, type PluginLayout } from '@opensip-cli/core';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerCliCommands } from '../commands/index.js';

import type { CommandResult } from '@opensip-cli/contracts';

function makeContext(pluginLayouts: readonly PluginLayout[] = []): {
  setExitCode: ReturnType<typeof vi.fn>;
  render: (result: CommandResult) => Promise<void>;
  datastore: () => unknown;
  pluginLayouts: readonly PluginLayout[];
  tools?: ToolRegistry;
} {
  const tools = new ToolRegistry();
  if (pluginLayouts.some((l) => l.domain === 'fit')) {
    tools.register({
      identity: { name: 'fitness', layoutKey: 'fit' },
      metadata: { id: 'f', name: 'fitness', version: '0', description: '' },
      commandSpecs: [],
      pluginLayout: { domain: 'fit', userSubdirs: ['checks', 'recipes'] },
    });
  }
  if (pluginLayouts.some((l) => l.domain === 'sim')) {
    tools.register({
      identity: { name: 'simulation', layoutKey: 'sim' },
      metadata: { id: 's', name: 'simulation', version: '0', description: '' },
      commandSpecs: [],
      pluginLayout: { domain: 'sim', userSubdirs: ['scenarios', 'recipes'] },
    });
  }
  return {
    setExitCode: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    datastore: () => undefined,
    pluginLayouts,
    tools,
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
  it('mounts every CLI-owned top-level command (no top-level `plugin`)', () => {
    const program = new Command('opensip');
    registerCliCommands(program, makeContext());

    // `__tool-command-worker` is the ADR-0054 M4-E host-mounted internal worker
    // subcommand (the dispatch supervisor forks it). It is PRESENT in the mounted
    // tree (invocable) but `visibility:'internal'`, so it is hidden from `--help`
    // and completion — asserted in command-surface-parity.snapshot.test.ts.
    expect(topLevelNames(program)).toEqual([
      '__tool-command-worker',
      'agent-catalog',
      'completion',
      'configure',
      'init',
      'report',
      'sessions',
      'tools',
      'uninstall',
    ]);
  });

  it('mounts the documented sessions subcommands', () => {
    const program = new Command('opensip');
    registerCliCommands(program, makeContext());
    expect(subcommandNames(program, 'sessions')).toEqual(['list', 'purge', 'show']);
  });

  it('mounts the domain-bound plugin subcommands UNDER each pack-supporting tool primary', () => {
    const program = new Command('opensip');
    // Stub the pack-supporting tool primaries (the composition root mounts tools
    // before the host commands), then mount host commands with their layouts.
    program.command('fitness').description('Run fitness checks');
    program.command('simulation').description('Run simulation scenarios');
    registerCliCommands(
      program,
      makeContext([
        { domain: 'fit', userSubdirs: ['checks', 'recipes'] },
        { domain: 'sim', userSubdirs: ['scenarios', 'recipes'] },
      ]),
    );

    // No top-level `plugin` group.
    expect(program.commands.find((c) => c.name() === 'plugin')).toBeUndefined();
    for (const toolVerb of ['fitness', 'simulation']) {
      const primary = program.commands.find((c) => c.name() === toolVerb)!;
      expect(subcommandNames(primary, 'plugin')).toEqual(['add', 'list', 'remove', 'sync']);
    }
  });

  it('does not mount any tool subcommands (those come via tool.register)', () => {
    const program = new Command('opensip');
    registerCliCommands(program, makeContext());
    const names = topLevelNames(program);
    expect(names).not.toContain('fitness');
    expect(names).not.toContain('simulation');
    expect(names).not.toContain('graph');
  });
});
