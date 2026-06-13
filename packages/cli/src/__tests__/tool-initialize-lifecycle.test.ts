/**
 * Tool.initialize() lifecycle test (audit P1a).
 *
 * The Tool contract documents initialize() as "called by the CLI before
 * any of the tool's commands run … at most once per process." Before this
 * fix it was declared, implemented (fitness no-op), and documented — but
 * never called by any composition root. This test pins the wiring: the
 * preAction hook resolves the tool owning the invoked subcommand and runs
 * its initialize() exactly once, before the action body, and fails the run
 * closed when initialize() throws.
 *
 * It drives the REAL Commander program + installPreActionHook against the
 * sample-project fixture (a valid project, so no no-project bailout), with
 * a fixture Tool injected via setCliRegistriesForRun.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LanguageRegistry, ToolRegistry, type Tool, type ToolCliContext } from '@opensip-cli/core';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installPreActionHook, resolveOwningTool } from '../bootstrap/pre-action-hook.js';
import { mountAllToolCommands } from '../bootstrap/register-tools.js';
import { setCliRegistriesForRun } from '../cli-context.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/sample-project');

/** Minimal handler-facing ToolCliContext (no Commander program — 3.0.0). */
function stubCtx(): ToolCliContext {
  return {
    project: {
      cwd: FIXTURE,
      cwdExplicit: false,
      projectRoot: FIXTURE,
      configPath: undefined,
      walkedUp: 0,
      scope: 'none',
    },
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    datastore: undefined,
  };
}

interface FixtureOpts {
  readonly throwOnInit?: boolean;
  readonly aliases?: readonly string[];
}

function makeFixtureTool(
  id: string,
  cmdName: string,
  events: string[],
  opts: FixtureOpts = {},
): Tool {
  return {
    metadata: { id, version: '0.0.0', description: 'fixture tool' },
    commands: [{ name: cmdName, description: 'fixture command', aliases: opts.aliases }],
    initialize: () => {
      events.push(`initialize:${id}`);
      return opts.throwOnInit ? Promise.reject(new Error('init boom')) : Promise.resolve();
    },
    // 3.0.0: the command surface is the declarative commandSpec (register() gone).
    // The handler records the action; the host mounts it + the `--cwd` common flag.
    commandSpecs: [
      {
        name: cmdName,
        description: 'fixture command',
        aliases: opts.aliases ? [...opts.aliases] : undefined,
        commonFlags: ['cwd'],
        scope: 'project',
        output: 'command-result',
        handler: () => {
          events.push(`action:${cmdName}`);
          return { type: 'ok' };
        },
      },
    ] as never,
  };
}

/** Wire a program with the preAction hook + the fixture tool's mounted command. */
function buildProgram(tool: Tool): Command {
  const tools = new ToolRegistry();
  tools.register(tool);
  setCliRegistriesForRun({ languages: new LanguageRegistry(), tools });
  const program = new Command();
  program.exitOverride();
  installPreActionHook(program, 'test');
  mountAllToolCommands(tools, program, stubCtx());
  return program;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveOwningTool', () => {
  const events: string[] = [];

  it('matches a tool by its command name', () => {
    const tools = new ToolRegistry();
    tools.register(makeFixtureTool('t1', 'cmd-a', events));
    expect(resolveOwningTool(tools, 'cmd-a')?.metadata.id).toBe('t1');
  });

  it('matches a tool by a command alias', () => {
    const tools = new ToolRegistry();
    tools.register(makeFixtureTool('t2', 'cmd-b', events, { aliases: ['cb'] }));
    expect(resolveOwningTool(tools, 'cb')?.metadata.id).toBe('t2');
  });

  it('returns undefined for a command owned by no tool (CLI-only)', () => {
    const tools = new ToolRegistry();
    tools.register(makeFixtureTool('t3', 'cmd-c', events));
    expect(resolveOwningTool(tools, 'init')).toBeUndefined();
  });
});

describe('Tool.initialize() wiring (preAction)', () => {
  it('runs initialize() exactly once, before the action body', async () => {
    const events: string[] = [];
    const program = buildProgram(makeFixtureTool('order-tool', 'order-cmd', events));

    await program.parseAsync(['node', 'cli', 'order-cmd', '--cwd', FIXTURE], { from: 'node' });

    expect(events).toEqual(['initialize:order-tool', 'action:order-cmd']);
  });

  it('does not re-run initialize() on a second invocation (once per process)', async () => {
    const events: string[] = [];
    const program = buildProgram(makeFixtureTool('memo-tool', 'memo-cmd', events));

    await program.parseAsync(['node', 'cli', 'memo-cmd', '--cwd', FIXTURE], { from: 'node' });
    await program.parseAsync(['node', 'cli', 'memo-cmd', '--cwd', FIXTURE], { from: 'node' });

    // initialize once total; action twice.
    expect(events).toEqual(['initialize:memo-tool', 'action:memo-cmd', 'action:memo-cmd']);
  });

  it('fails the run closed (exit 1) when initialize() throws, without running the action', async () => {
    const events: string[] = [];
    const program = buildProgram(
      makeFixtureTool('boom-tool', 'boom-cmd', events, { throwOnInit: true }),
    );

    // 2.12.0 (§4.7): a tool-init failure THROWS a typed BootstrapError (exit 1)
    // for the top-level boundary to render — it no longer calls process.exit
    // itself. The throw propagates out of parseAsync here (this bare test program
    // installs no catch boundary).
    await expect(
      program.parseAsync(['node', 'cli', 'boom-cmd', '--cwd', FIXTURE], { from: 'node' }),
    ).rejects.toMatchObject({
      name: 'BootstrapError',
      exitCode: 1,
      message: expect.stringContaining('failed to initialize'),
    });

    // initialize attempted, but the action never ran.
    expect(events).toEqual(['initialize:boom-tool']);
  });
});
