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

import { buildInitRecoverySpec, mountHostCommands } from '../commands/host-command-specs.js';
import { HOST_SUBCOMMAND_GROUPS } from '../commands/host-subcommand-groups.js';
import { mountCommandSpec } from '../commands/mount-command-spec.js';

import type { CliCommandsContext } from '../commands/shared.js';

function makeCtx() {
  let exitCode: number | undefined;
  return {
    ctx: {
      setExitCode: (n: number) => {
        exitCode = n;
      },
      render: () => Promise.resolve(),
      emitJson: () => undefined,
      emitRaw: () => undefined,
      emitError: () => undefined,
      pluginLayouts: [],
      toolScaffolds: [],
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
  it('registers `init` with the expected flags and bounded conflict policy', () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);
    const cmd = findSubcommand(program, 'init');
    expect(cmd).toBeDefined();
    const flagNames = cmd!.options.map((o) => o.long);
    expect(flagNames).toEqual(
      expect.arrayContaining([
        '--cwd',
        '--language',
        '--keep',
        '--remove',
        '--runtime-conflict',
        '--json',
        '--debug',
      ]),
    );
    const runtimeConflict = cmd!.options.find((option) => option.long === '--runtime-conflict');
    expect(runtimeConflict?.argChoices).toEqual(['abort', 'keep-project', 'use-cache']);
    expect(runtimeConflict?.defaultValue).toBeUndefined();
    expect(cmd!.description()).toMatch(/Scaffold/i);
  });

  it('mounts the recovery-only Init spec with byte-for-byte canonical grammar', () => {
    const { ctx } = makeCtx();
    const regular = findSubcommand(mount(ctx), 'init');
    const recoveryProgram = new Command('opensip');
    mountCommandSpec(recoveryProgram, buildInitRecoverySpec(ctx), ctx);
    const recovery = findSubcommand(recoveryProgram, 'init');

    expect(recovery).toBeDefined();
    expect(recovery?.description()).toBe(regular?.description());
    expect(
      recovery?.options.map((option) => ({
        flags: option.flags,
        choices: option.argChoices,
        defaultValue: option.defaultValue,
      })),
    ).toEqual(
      regular?.options.map((option) => ({
        flags: option.flags,
        choices: option.argChoices,
        defaultValue: option.defaultValue,
      })),
    );
  });
});

describe('audit wiring', () => {
  it('registers exactly one canonical audit command with bounded workflow flags', () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);
    const matches = program.commands.filter((command) => command.name() === 'audit');

    expect(matches).toHaveLength(1);
    const flags = matches[0].options.map((option) => option.long);
    expect(flags).toEqual(
      expect.arrayContaining([
        '--cwd',
        '--json',
        '--quiet',
        '--verbose',
        '--debug',
        '--open',
        '--config',
        '--changed',
        '--since',
        '--files',
        '--full',
      ]),
    );
    expect(flags).not.toContain('--report-to');
    expect(flags).not.toContain('--api-key');
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

describe('status wiring', () => {
  it('registers the read-only first-run status surface', () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);
    const cmd = findSubcommand(program, 'status');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe("Show where this project's OpenSIP evidence is stored");
    expect(cmd!.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--cwd', '--json', '--debug']),
    );
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

describe('runs wiring', () => {
  it('registers `runs list|show` with bounded read flags', () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);
    const cmd = findSubcommand(program, 'runs');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toBe('Inspect parent Runs and ordered RunSteps');
    expect(cmd?.commands.map((command) => command.name())).toEqual(['list', 'show']);
    expect(findSubcommand(cmd!, 'list')?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--json', '--limit']),
    );
    expect(findSubcommand(cmd!, 'show')?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--json', '--offset', '--limit']),
    );
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
  it('is exactly [config, policy, repair, runs, sessions, suite, tools]', () => {
    // `plugin` was RETIRED as a top-level group: pack ops now mount under each
    // pack-supporting tool primary (`opensip fit plugin …`), not at the root.
    expect([...HOST_SUBCOMMAND_GROUPS].sort()).toEqual([
      'config',
      'policy',
      'repair',
      'runs',
      'sessions',
      'suite',
      'tools',
    ]);
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
