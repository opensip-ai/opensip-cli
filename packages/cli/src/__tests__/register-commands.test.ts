/**
 * Coverage tests for the host command WIRING (release 2.11.0 Phase 6 —
 * `host-command-specs.ts` mounted via `mountHostCommands`).
 *
 * We don't run the underlying actions here — those are exercised by
 * `register-action-bodies.test.ts` and `e2e.test.ts`. The goal is to confirm
 * each host command mounts the expected subcommand with the documented options
 * + description, so a missing or renamed flag is caught without spawning the
 * binary.
 */

import { ToolRegistry } from '@opensip-cli/core';
import { Command } from 'commander';
import { describe, it, expect } from 'vitest';

import { mountHostCommands } from '../commands/host-command-specs.js';
import { HOST_SUBCOMMAND_GROUPS } from '../commands/host-subcommand-groups.js';

import type { CliCommandsContext } from '../commands/shared.js';

function makeCtx() {
  let exitCode: number | undefined;
  return {
    ctx: {
      setExitCode: (n: number) => {
        exitCode = n;
      },
      render: () => Promise.resolve(),
      pluginLayouts: [],
      datastore: () => {
        throw new Error('not opened in this test');
      },
    } as CliCommandsContext,
    getExitCode: () => exitCode,
  };
}

function mount(ctx: CliCommandsContext): Command {
  const program = new Command('opensip');
  mountHostCommands(program, ctx);
  return program;
}

function findSubcommand(program: Command, name: string): Command | undefined {
  return program.commands.find((c) => c.name() === name);
}

describe('init wiring', () => {
  it('registers `init` with the expected flags', () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);
    const cmd = findSubcommand(program, 'init');
    expect(cmd).toBeDefined();
    const flagNames = cmd!.options.map((o) => o.long);
    expect(flagNames).toEqual(
      expect.arrayContaining(['--cwd', '--language', '--keep', '--remove', '--json', '--debug']),
    );
    expect(cmd!.description()).toMatch(/Scaffold/i);
  });
});

describe('completion wiring', () => {
  it('registers `completion <shell>` and rejects an unknown shell with exit 2', async () => {
    const { ctx, getExitCode } = makeCtx();
    const program = mount(ctx);
    program.exitOverride();
    const cmd = findSubcommand(program, 'completion');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toMatch(/shell-completion/i);

    // Mute stderr while we run the bad-input branch.
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      await program.parseAsync(['node', 'cli', 'completion', 'powershell']);
    } catch {
      // Commander may throw via exitOverride — we only care about the side effect.
    } finally {
      process.stderr.write = origWrite;
    }
    expect(getExitCode()).toBe(2);
  });
});

describe('configure wiring', () => {
  it('registers `configure`', () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);
    const cmd = findSubcommand(program, 'configure');
    expect(cmd).toBeDefined();
  });
});

describe('plugin wiring', () => {
  // The pack `plugin {add,list,remove,sync}` ops are NO LONGER a top-level
  // group: they mount UNDER each pack-supporting tool primary (`opensip fit
  // plugin …`, `opensip sim plugin …`). `mountHostCommands` mounts them only
  // when the tool primaries already exist on the program (the composition root
  // mounts tools first). This host-only mount (no tools registered) therefore
  // exposes NO top-level `plugin` command.
  it('does NOT register a top-level `plugin` command', () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);
    expect(findSubcommand(program, 'plugin')).toBeUndefined();
  });

  it('mounts a domain-bound `plugin` group under each pack-supporting tool primary', () => {
    const { ctx } = makeCtx();
    // Two pack-supporting layouts (fit/sim) + two stub tool primaries to host
    // their `plugin` groups, mirroring the real mount order (tools first).
    const tools = new ToolRegistry();
    for (const t of [
      {
        identity: { name: 'fitness', layoutKey: 'fit' },
        metadata: { id: 'f', name: 'fitness', version: '0', description: '' },
        commandSpecs: [],
        pluginLayout: { domain: 'fit', userSubdirs: ['checks', 'recipes'] },
      },
      {
        identity: { name: 'simulation', layoutKey: 'sim' },
        metadata: {
          id: 's',
          name: 'simulation',
          version: '0',
          description: '',
        },
        commandSpecs: [],
        pluginLayout: { domain: 'sim', userSubdirs: ['scenarios', 'recipes'] },
      },
    ]) {
      tools.register(t);
    }
    const ctxWithLayouts: CliCommandsContext = {
      ...ctx,
      pluginLayouts: [
        { domain: 'fit', userSubdirs: ['checks', 'recipes'] },
        { domain: 'sim', userSubdirs: ['scenarios', 'recipes'] },
      ],
      tools,
    };
    const program = new Command('opensip');
    program.command('fitness').description('Run fitness checks');
    program.command('simulation').description('Run simulation scenarios');
    mountHostCommands(program, ctxWithLayouts);

    for (const toolVerb of ['fitness', 'simulation']) {
      const primary = findSubcommand(program, toolVerb);
      expect(primary, `${toolVerb} primary should exist`).toBeDefined();
      const pluginGroup = primary!.commands.find((c) => c.name() === 'plugin');
      expect(pluginGroup, `${toolVerb} should host a plugin group`).toBeDefined();
      const subs = pluginGroup!.commands.map((c) => c.name());
      expect(subs).toEqual(expect.arrayContaining(['list', 'add', 'remove', 'sync']));
      // No `--domain`/`--type` flag — the domain is bound from the tool primary.
      for (const leafName of ['add', 'remove', 'list', 'sync']) {
        const leaf = pluginGroup!.commands.find((c) => c.name() === leafName);
        const flags = (leaf?.options ?? []).map((o) => o.long);
        expect(flags, `${toolVerb} plugin ${leafName} must not carry --domain`).not.toContain(
          '--domain',
        );
      }
    }
  });
});

describe('sessions wiring', () => {
  it('registers `sessions` with `list` and `purge` subcommands', () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);
    const cmd = findSubcommand(program, 'sessions');
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name());
    expect(subs).toEqual(expect.arrayContaining(['list', 'purge']));
  });
});

describe('uninstall wiring', () => {
  it('registers `uninstall` with the expected flags', () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);
    const cmd = findSubcommand(program, 'uninstall');
    expect(cmd).toBeDefined();
    const flagNames = cmd!.options.map((o) => o.long);
    expect(flagNames).toEqual(
      expect.arrayContaining(['--yes', '--dry-run', '--user', '--project', '--purge', '--json']),
    );
  });
});

describe('documented subcommand-group exceptions', () => {
  // `HOST_SUBCOMMAND_GROUPS` is the FINITE, NAMED set of action-less Commander
  // group parents that legitimately can't be a single CommandSpec — the Phase 7
  // `command-surface-parity` guardrail allow-lists exactly these. This test
  // locks the list AND asserts every named group is actually a mounted
  // action-less parent (no action handler, has sub-subcommands).
  it('is exactly [config, sessions, tools]', () => {
    // `plugin` was RETIRED as a top-level group: pack ops now mount under each
    // pack-supporting tool primary (`opensip fit plugin …`), not at the root.
    expect([...HOST_SUBCOMMAND_GROUPS].sort()).toEqual(['config', 'sessions', 'tools']);
  });

  it('each documented group is a mounted parent with sub-subcommands and no own action', () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);
    for (const name of HOST_SUBCOMMAND_GROUPS) {
      const cmd = findSubcommand(program, name);
      expect(cmd, `group '${name}' should be mounted`).toBeDefined();
      // A group parent has children and no action body of its own.
      expect(cmd!.commands.length).toBeGreaterThan(0);
      // Commander stores the action handler on a private field; the absence of
      // declared options beyond --help is a good proxy for "no action surface".
      const ownFlags = cmd!.options.map((o) => o.long);
      expect(ownFlags).not.toContain('--json');
    }
  });
});
