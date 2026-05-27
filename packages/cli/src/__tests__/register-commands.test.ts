/**
 * Coverage tests for the `register-*.ts` Commander wiring.
 *
 * We don't actually run the underlying actions here — those are integration
 * code exercised by `e2e.test.ts`. The goal is to confirm each registrar
 * mounts the expected subcommand with the documented options + description,
 * so a missing or renamed flag is caught without spawning the binary.
 */

import { Command } from 'commander';
import { describe, it, expect } from 'vitest';

import { registerCompletion } from '../commands/register-completion.js';
import { registerConfigure } from '../commands/register-configure.js';
import { registerInit } from '../commands/register-init.js';
import { registerPlugins } from '../commands/register-plugins.js';
import { registerSessions } from '../commands/register-sessions.js';
import { registerUninstall } from '../commands/register-uninstall.js';

function makeCtx() {
  let exitCode: number | undefined;
  return {
    ctx: {
      setExitCode: (n: number) => {
        exitCode = n;
      },
      render: () => Promise.resolve(),
      datastore: () => {
        throw new Error('not opened in this test');
      },
    } as never,
    getExitCode: () => exitCode,
  };
}

function findSubcommand(program: Command, name: string): Command | undefined {
  return program.commands.find((c) => c.name() === name);
}

describe('registerInit', () => {
  it('registers `init` with the expected flags', () => {
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerInit(program, ctx);
    const cmd = findSubcommand(program, 'init');
    expect(cmd).toBeDefined();
    const flagNames = cmd!.options.map((o) => o.long);
    expect(flagNames).toEqual(
      expect.arrayContaining(['--cwd', '--language', '--keep', '--remove', '--json', '--debug']),
    );
    expect(cmd!.description()).toMatch(/Scaffold/i);
  });
});

describe('registerCompletion', () => {
  it('registers `completion <shell>` and rejects an unknown shell with exit 2', async () => {
    const program = new Command('opensip-tools').exitOverride();
    const { ctx, getExitCode } = makeCtx();
    registerCompletion(program, ctx);
    const cmd = findSubcommand(program, 'completion');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toMatch(/shell-completion/i);

    // Mute stderr while we run the bad-input branch.
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true);
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

describe('registerConfigure', () => {
  it('registers `configure`', () => {
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerConfigure(program, ctx);
    const cmd = findSubcommand(program, 'configure');
    expect(cmd).toBeDefined();
  });
});

describe('registerPlugins', () => {
  it('registers `plugin` with the expected subcommands', () => {
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerPlugins(program, ctx);
    const cmd = findSubcommand(program, 'plugin');
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name());
    expect(subs).toEqual(expect.arrayContaining(['list', 'add', 'remove', 'sync']));
  });
});

describe('registerSessions', () => {
  it('registers `sessions` with `list` and `purge` subcommands', () => {
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerSessions(program, ctx);
    const cmd = findSubcommand(program, 'sessions');
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name());
    expect(subs).toEqual(expect.arrayContaining(['list', 'purge']));
  });
});

describe('registerUninstall', () => {
  it('registers `uninstall` with the expected flags', () => {
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerUninstall(program, ctx);
    const cmd = findSubcommand(program, 'uninstall');
    expect(cmd).toBeDefined();
    const flagNames = cmd!.options.map((o) => o.long);
    expect(flagNames).toEqual(
      expect.arrayContaining(['--yes', '--dry-run', '--project', '--purge', '--json']),
    );
  });
});
