/* eslint-disable sonarjs/deprecation -- exercises the deprecated-but-supported Tool.register() contract through 2.x (removed in 3.0.0; fit/graph/sim migrate to commandSpecs in release 2.11.0 Phases 3-5). The register() path is sanctioned until then, so these tests must access it. */
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

import {
  LanguageRegistry,
  ToolRegistry,
  type Tool,
  type ToolCliContext,
} from '@opensip-tools/core';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installPreActionHook, resolveOwningTool } from '../bootstrap/pre-action-hook.js';
import { setCliRegistriesForRun } from '../cli-context.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/sample-project');

/** Minimal ToolCliContext — the fixture's register() only touches program. */
function stubCtx(program: Command): ToolCliContext {
  return {
    program,
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
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
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
      return opts.throwOnInit
        ? Promise.reject(new Error('init boom'))
        : Promise.resolve();
    },
    register: (cli: ToolCliContext) => {
      cli.program
        .command(cmdName)
        .option('--cwd <path>', 'dir')
        .action(() => {
          events.push(`action:${cmdName}`);
        });
    },
  };
}

/** Wire a program with the preAction hook + a registered/mounted fixture tool. */
function buildProgram(tool: Tool): Command {
  const tools = new ToolRegistry();
  tools.register(tool);
  setCliRegistriesForRun({ languages: new LanguageRegistry(), tools });
  const program = new Command();
  program.exitOverride();
  installPreActionHook(program, 'test');
  tool.register!(stubCtx(program));
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
    expect(events).toEqual([
      'initialize:memo-tool',
      'action:memo-cmd',
      'action:memo-cmd',
    ]);
  });

  it('fails the run closed (exit 1) when initialize() throws, without running the action', async () => {
    const events: string[] = [];
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${String(code)}`);
      }) as never);
    const program = buildProgram(
      makeFixtureTool('boom-tool', 'boom-cmd', events, { throwOnInit: true }),
    );

    await expect(
      program.parseAsync(['node', 'cli', 'boom-cmd', '--cwd', FIXTURE], { from: 'node' }),
    ).rejects.toThrow('process.exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // initialize attempted, but the action never ran.
    expect(events).toEqual(['initialize:boom-tool']);
  });
});
