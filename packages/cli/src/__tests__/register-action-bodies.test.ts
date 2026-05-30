/**
 * Tests that exercise the action-body lambdas in each `register-*.ts`
 * Commander wiring file.
 *
 * `register-commands.test.ts` already confirms each registrar mounts the
 * correct subcommand + flags. The lambdas inside `mountResultCommand`
 * (the `handler` closure + the `jsonFlag` reader + small helpers like
 * `effectiveCwd`) only execute when Commander actually dispatches the
 * action, which the wiring tests never do. These tests fire each action
 * through `parseAsync` with a stub `ctx`, against mocked I/O functions,
 * so coverage attributes the lambda bodies back to the source files.
 */

import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock the underlying handlers so we can drive the wiring deterministically. ---
vi.mock('../commands/plugin.js', () => ({
  pluginList: vi.fn((cwd: string) =>
    Promise.resolve({ type: 'plugin', action: 'list', cwd, plugins: [] } as never),
  ),
  pluginAdd: vi.fn((pkg: string, cwd: string, domain: string | undefined) =>
    Promise.resolve({ type: 'plugin', action: 'add', pkg, cwd, domain } as never),
  ),
  pluginRemove: vi.fn((pkg: string, cwd: string, domain: string | undefined) =>
    Promise.resolve({ type: 'plugin', action: 'remove', pkg, cwd, domain } as never),
  ),
  pluginSync: vi.fn((cwd: string, domain: string | undefined) =>
    Promise.resolve({ type: 'plugin', action: 'sync', cwd, domain } as never),
  ),
}));

vi.mock('../commands/history.js', () => ({
  showHistory: vi.fn(() => Promise.resolve({ type: 'history' } as never)),
}));

vi.mock('../commands/clear.js', () => ({
  executeClear: vi.fn((opts: unknown) =>
    Promise.resolve({ type: 'clear', opts } as never),
  ),
}));

vi.mock('../commands/configure.js', () => ({
  executeConfigure: vi.fn(() =>
    Promise.resolve({ type: 'configure-done', action: 'cancelled', configPath: '/var/opt/x' } as never),
  ),
}));

vi.mock('../commands/init.js', () => ({
  executeInit: vi.fn((args: { cwd: string }) => ({
    type: 'init',
    path: `${args.cwd}/opensip-tools.config.yml`,
    cwd: args.cwd,
    configFilename: 'opensip-tools.config.yml',
    created: true,
  } as never)),
}));

vi.mock('../commands/uninstall.js', () => ({
  executeUninstall: vi.fn((opts: { project?: string | true }) =>
    Promise.resolve({
      type: 'uninstall-done',
      action: 'cancelled',
      mode: opts.project === undefined ? 'user' : 'project',
      removed: false,
      cancelled: true,
      targets: [],
      rootPath: '/x',
    } as never),
  ),
}));

import { executeClear } from '../commands/clear.js';
import { executeConfigure } from '../commands/configure.js';
import { showHistory } from '../commands/history.js';
import { executeInit } from '../commands/init.js';
import { pluginAdd, pluginList, pluginRemove, pluginSync } from '../commands/plugin.js';
import { registerConfigure } from '../commands/register-configure.js';
import { registerInit } from '../commands/register-init.js';
import { registerPlugins } from '../commands/register-plugins.js';
import { registerSessions } from '../commands/register-sessions.js';
import { registerUninstall } from '../commands/register-uninstall.js';
import { executeUninstall } from '../commands/uninstall.js';

import type { CliCommandsContext } from '../commands/shared.js';
import type { CommandResult } from '@opensip-tools/contracts';

interface MakeCtxResult {
  ctx: CliCommandsContext;
  rendered: CommandResult[];
  setExitCode: ReturnType<typeof vi.fn>;
  datastore: ReturnType<typeof vi.fn>;
}

function makeCtx(): MakeCtxResult {
  const rendered: CommandResult[] = [];
  const setExitCode = vi.fn();
  const datastore = vi.fn(() => ({ __stub: 'datastore' }));
  const ctx: CliCommandsContext = {
    setExitCode,
    render: vi.fn((r: CommandResult) => {
      rendered.push(r);
      return Promise.resolve();
    }),
    datastore,
  };
  return { ctx, rendered, setExitCode, datastore };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- register-plugins ---------------------------------------------------------

describe('registerPlugins — action bodies', () => {
  it('plugin list: invokes pluginList with effectiveCwd (projectContext wins)', async () => {
    const program = new Command('opensip-tools');
    const { ctx, rendered } = makeCtx();
    registerPlugins(program, ctx);

    // Attach a projectContext on the listCmd to simulate the pre-action
    // hook's mutation — effectiveCwd should prefer it over --cwd.
    const pluginCmd = program.commands.find((c) => c.name() === 'plugin');
    const listCmd = pluginCmd?.commands.find((c) => c.name() === 'list');
    listCmd?.setOptionValue('projectContext', {
      projectRoot: '/discovered/root',
      scope: 'project',
      walkedUp: 0,
    });

    await program.parseAsync(['plugin', 'list'], { from: 'user' });

    expect(pluginList).toHaveBeenCalledWith('/discovered/root');
    expect(rendered).toHaveLength(1);
  });

  it('plugin list --json: short-circuits render and uses effectiveCwd with --cwd fallback', async () => {
    const program = new Command('opensip-tools');
    const { ctx, rendered } = makeCtx();
    registerPlugins(program, ctx);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      writes.push(String(c));
      return true;
    });
    try {
      await program.parseAsync(['plugin', 'list', '--cwd', '/explicit/cwd', '--json'], { from: 'user' });
    } finally {
      spy.mockRestore();
    }
    expect(pluginList).toHaveBeenCalledWith('/explicit/cwd');
    expect(rendered).toHaveLength(0);
    expect(writes.join('')).toContain('"action": "list"');
  });

  it('plugin add: forwards the positional arg, --domain, and effectiveCwd', async () => {
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerPlugins(program, ctx);

    await program.parseAsync(['plugin', 'add', '@my-co/foo', '--cwd', '/p', '--domain', 'fit'], { from: 'user' });
    expect(pluginAdd).toHaveBeenCalledWith('@my-co/foo', '/p', 'fit');
  });

  it('plugin remove: forwards the positional arg, --domain, and effectiveCwd', async () => {
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerPlugins(program, ctx);

    await program.parseAsync(['plugin', 'remove', '@my-co/foo', '--cwd', '/p', '--domain', 'sim'], { from: 'user' });
    expect(pluginRemove).toHaveBeenCalledWith('@my-co/foo', '/p', 'sim');
  });

  it('plugin sync: forwards --domain and effectiveCwd', async () => {
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerPlugins(program, ctx);

    await program.parseAsync(['plugin', 'sync', '--cwd', '/p'], { from: 'user' });
    expect(pluginSync).toHaveBeenCalledWith('/p', undefined);
  });
});

// --- register-sessions --------------------------------------------------------

describe('registerSessions — action bodies', () => {
  it('sessions list: invokes showHistory with the datastore', async () => {
    const program = new Command('opensip-tools');
    const { ctx, rendered, datastore } = makeCtx();
    registerSessions(program, ctx);

    await program.parseAsync(['sessions', 'list'], { from: 'user' });

    expect(datastore).toHaveBeenCalled();
    expect(showHistory).toHaveBeenCalled();
    expect(rendered).toHaveLength(1);
  });

  it('sessions purge: invokes executeClear with the parsed flags', async () => {
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerSessions(program, ctx);

    await program.parseAsync(['sessions', 'purge', '--older-than', '7', '--yes'], { from: 'user' });

    expect(executeClear).toHaveBeenCalledWith(
      expect.objectContaining({ olderThan: 7, yes: true }),
    );
  });

  it('sessions purge --json: emits JSON and skips render', async () => {
    const program = new Command('opensip-tools');
    const { ctx, rendered } = makeCtx();
    registerSessions(program, ctx);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      writes.push(String(c));
      return true;
    });
    try {
      await program.parseAsync(['sessions', 'purge', '--json'], { from: 'user' });
    } finally {
      spy.mockRestore();
    }
    expect(rendered).toHaveLength(0);
    expect(writes.join('')).toContain('"type": "clear"');
  });
});

// --- register-configure -------------------------------------------------------

describe('registerConfigure — action body', () => {
  it('configure: invokes executeConfigure and renders the result', async () => {
    const program = new Command('opensip-tools');
    const { ctx, rendered } = makeCtx();
    registerConfigure(program, ctx);

    await program.parseAsync(['configure'], { from: 'user' });
    expect(executeConfigure).toHaveBeenCalled();
    expect(rendered).toHaveLength(1);
  });

  it('configure --json: short-circuits render', async () => {
    const program = new Command('opensip-tools');
    const { ctx, rendered } = makeCtx();
    registerConfigure(program, ctx);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      writes.push(String(c));
      return true;
    });
    try {
      await program.parseAsync(['configure', '--json'], { from: 'user' });
    } finally {
      spy.mockRestore();
    }
    expect(rendered).toHaveLength(0);
    expect(writes.join('')).toContain('"type": "configure-done"');
  });
});

// --- register-init ------------------------------------------------------------

describe('registerInit — action body', () => {
  it('init: invokes executeInit with parsed flags + cwdExplicit=false when default', async () => {
    const program = new Command('opensip-tools');
    const { ctx, rendered } = makeCtx();
    registerInit(program, ctx);

    await program.parseAsync(['init'], { from: 'user' });
    expect(executeInit).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(executeInit).mock.calls[0]?.[0] as {
      cwd: string; cwdExplicit: boolean; json: boolean; language?: string;
    };
    expect(callArgs.json).toBe(false);
    expect(callArgs.cwdExplicit).toBe(false);
    expect(rendered).toHaveLength(1);
  });

  it('init: cwdExplicit=true when --cwd is supplied on the CLI', async () => {
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerInit(program, ctx);

    await program.parseAsync(['init', '--cwd', '/explicit'], { from: 'user' });
    const callArgs = vi.mocked(executeInit).mock.calls.at(-1)?.[0] as {
      cwd: string; cwdExplicit: boolean;
    };
    expect(callArgs.cwd).toBe('/explicit');
    expect(callArgs.cwdExplicit).toBe(true);
  });

  it('init: sets exit-code 2 when result.ambiguousLanguageError is set', async () => {
    vi.mocked(executeInit).mockReturnValueOnce({
      type: 'init',
      path: '',
      cwd: process.cwd(),
      configFilename: 'opensip-tools.config.yml',
      created: false,
      ambiguousLanguageError: { detected: [], message: 'ambiguous' },
    } as never);

    const program = new Command('opensip-tools');
    const { ctx, setExitCode } = makeCtx();
    registerInit(program, ctx);

    await program.parseAsync(['init'], { from: 'user' });
    expect(setExitCode).toHaveBeenCalledWith(2);
  });

  it('init: sets exit-code 2 when result.partialStateError is set', async () => {
    vi.mocked(executeInit).mockReturnValueOnce({
      type: 'init',
      path: '',
      cwd: process.cwd(),
      configFilename: 'opensip-tools.config.yml',
      created: false,
      partialStateError: { state: 'fully-initialized', preExistingFiles: [], message: 'm' },
    } as never);

    const program = new Command('opensip-tools');
    const { ctx, setExitCode } = makeCtx();
    registerInit(program, ctx);

    await program.parseAsync(['init'], { from: 'user' });
    expect(setExitCode).toHaveBeenCalledWith(2);
  });

  it('init: sets exit-code 2 when result.insideExistingProject is set', async () => {
    vi.mocked(executeInit).mockReturnValueOnce({
      type: 'init',
      path: '',
      cwd: process.cwd(),
      configFilename: 'opensip-tools.config.yml',
      created: false,
      insideExistingProject: { discoveredRoot: '/r', message: 'm' },
    } as never);

    const program = new Command('opensip-tools');
    const { ctx, setExitCode } = makeCtx();
    registerInit(program, ctx);

    await program.parseAsync(['init'], { from: 'user' });
    expect(setExitCode).toHaveBeenCalledWith(2);
  });

  it('init --json: short-circuits render and emits JSON', async () => {
    const program = new Command('opensip-tools');
    const { ctx, rendered } = makeCtx();
    registerInit(program, ctx);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      writes.push(String(c));
      return true;
    });
    try {
      await program.parseAsync(['init', '--json'], { from: 'user' });
    } finally {
      spy.mockRestore();
    }
    expect(rendered).toHaveLength(0);
    expect(writes.join('')).toContain('"type": "init"');
  });
});

// --- register-uninstall -------------------------------------------------------

describe('registerUninstall — action body', () => {
  it('uninstall: forwards --yes / --dry-run to executeUninstall (user mode by default)', async () => {
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerUninstall(program, ctx);

    await program.parseAsync(['uninstall', '--yes', '--dry-run'], { from: 'user' });
    expect(executeUninstall).toHaveBeenCalledWith(
      expect.objectContaining({ yes: true, dryRun: true, project: undefined }),
    );
  });

  it('uninstall --project (no value): forwards project=true', async () => {
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerUninstall(program, ctx);

    await program.parseAsync(['uninstall', '--project', '--yes'], { from: 'user' });
    expect(executeUninstall).toHaveBeenCalledWith(
      expect.objectContaining({ project: true }),
    );
  });

  it('uninstall --project <path>: forwards project=<path>', async () => {
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerUninstall(program, ctx);

    await program.parseAsync(['uninstall', '--project', '/var/opt/some-proj', '--yes'], { from: 'user' });
    expect(executeUninstall).toHaveBeenCalledWith(
      expect.objectContaining({ project: '/var/opt/some-proj' }),
    );
  });

  it('uninstall --json: short-circuits render', async () => {
    const program = new Command('opensip-tools');
    const { ctx, rendered } = makeCtx();
    registerUninstall(program, ctx);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      writes.push(String(c));
      return true;
    });
    try {
      await program.parseAsync(['uninstall', '--json', '--yes'], { from: 'user' });
    } finally {
      spy.mockRestore();
    }
    expect(rendered).toHaveLength(0);
    expect(writes.join('')).toContain('"type": "uninstall-done"');
  });
});
