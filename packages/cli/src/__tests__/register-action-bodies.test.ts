/**
 * Tests that exercise the action-body handlers of the host command specs
 * (release 2.11.0 Phase 6 — `host-command-specs.ts`).
 *
 * `commands.test.ts` confirms `registerCliCommands` mounts the correct
 * subcommands + flags. The handler closures (the `executeX` delegation + the
 * `effectiveCwd` / `--json` short-circuit / exit-code logic) only execute when
 * Commander dispatches the action. These tests fire each action through
 * `parseAsync` with a stub `ctx`, against mocked I/O functions, so the handler
 * bodies are covered.
 *
 * Host commands mount through the SAME `mountCommandSpec` plane the tools use.
 * The specs are built+mounted by `mountHostCommands`; `init`'s former
 * `getOptionValueSource('cwd')` recompute now reads `opts.cwdExplicit`, which
 * the pre-action hook stashes in the real CLI — these tests set it directly to
 * simulate the hook (the same way they set `projectContext`).
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
  executeClear: vi.fn((opts: unknown) => Promise.resolve({ type: 'clear', opts } as never)),
}));

vi.mock('../commands/configure.js', () => ({
  executeConfigure: vi.fn(() =>
    Promise.resolve({
      type: 'configure-done',
      action: 'cancelled',
      configPath: '/var/opt/x',
    } as never),
  ),
}));

vi.mock('../commands/init.js', () => ({
  executeInit: vi.fn(
    (args: { cwd: string }) =>
      ({
        type: 'init',
        path: `${args.cwd}/opensip-tools.config.yml`,
        cwd: args.cwd,
        configFilename: 'opensip-tools.config.yml',
        created: true,
      }) as never,
  ),
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
import { mountHostCommands } from '../commands/host-command-specs.js';
import { buildHostCommandInventory } from '../commands/host-subcommand-groups.js';
import { executeInit } from '../commands/init.js';
import { pluginAdd, pluginList, pluginRemove, pluginSync } from '../commands/plugin.js';
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
    pluginLayouts: [
      { domain: 'fit', userSubdirs: ['checks', 'recipes'] },
      { domain: 'sim', userSubdirs: ['scenarios', 'recipes'] },
    ],
  };
  return { ctx, rendered, setExitCode, datastore };
}

/** Mount the host commands and return the freshly-built program. */
function mount(ctx: CliCommandsContext): Command {
  const program = new Command('opensip-tools');
  mountHostCommands(program, ctx);
  return program;
}

/** Find a top-level command. */
function topCmd(program: Command, name: string): Command {
  const cmd = program.commands.find((c) => c.name() === name);
  if (!cmd) throw new Error(`no command '${name}'`);
  return cmd;
}

/** Find a sub-subcommand under a group. */
function subCmd(program: Command, group: string, leaf: string): Command {
  const child = topCmd(program, group).commands.find((c) => c.name() === leaf);
  if (!child) throw new Error(`no '${group} ${leaf}'`);
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- plugin -------------------------------------------------------------------

describe('plugin spec — action bodies', () => {
  it('plugin list: invokes pluginList with effectiveCwd (projectContext wins)', async () => {
    const { ctx, rendered } = makeCtx();
    const program = mount(ctx);

    // Attach a projectContext on the listCmd to simulate the pre-action
    // hook's mutation — effectiveCwd should prefer it over --cwd.
    subCmd(program, 'plugin', 'list').setOptionValue('projectContext', {
      projectRoot: '/discovered/root',
      scope: 'project',
      walkedUp: 0,
    });

    await program.parseAsync(['plugin', 'list'], { from: 'user' });

    expect(pluginList).toHaveBeenCalledWith('/discovered/root', ctx.pluginLayouts);
    expect(rendered).toHaveLength(1);
  });

  it('plugin list --json: short-circuits render and uses effectiveCwd with --cwd fallback', async () => {
    const { ctx, rendered } = makeCtx();
    const program = mount(ctx);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      writes.push(String(c));
      return true;
    });
    try {
      await program.parseAsync(['plugin', 'list', '--cwd', '/explicit/cwd', '--json'], {
        from: 'user',
      });
    } finally {
      spy.mockRestore();
    }
    expect(pluginList).toHaveBeenCalledWith('/explicit/cwd', ctx.pluginLayouts);
    expect(rendered).toHaveLength(0);
    expect(writes.join('')).toContain('"action": "list"');
  });

  it('plugin add: forwards the positional arg, --domain, and effectiveCwd', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['plugin', 'add', '@my-co/foo', '--cwd', '/p', '--domain', 'fit'], {
      from: 'user',
    });
    expect(pluginAdd).toHaveBeenCalledWith('@my-co/foo', '/p', 'fit', ctx.pluginLayouts, {
      project: false,
    });
  });

  it('plugin remove: forwards the positional arg, --domain, and effectiveCwd', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['plugin', 'remove', '@my-co/foo', '--cwd', '/p', '--domain', 'sim'], {
      from: 'user',
    });
    expect(pluginRemove).toHaveBeenCalledWith('@my-co/foo', '/p', 'sim', ctx.pluginLayouts, {
      project: false,
    });
  });

  it('plugin sync: forwards --domain and effectiveCwd', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['plugin', 'sync', '--cwd', '/p'], { from: 'user' });
    expect(pluginSync).toHaveBeenCalledWith('/p', undefined, ctx.pluginLayouts);
  });
});

// --- sessions -----------------------------------------------------------------

describe('sessions spec — action bodies', () => {
  it('sessions list: invokes showHistory with the datastore', async () => {
    const { ctx, rendered, datastore } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['sessions', 'list'], { from: 'user' });

    expect(datastore).toHaveBeenCalled();
    expect(showHistory).toHaveBeenCalled();
    expect(rendered).toHaveLength(1);
  });

  it('sessions purge: invokes executeClear with the parsed flags', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['sessions', 'purge', '--older-than', '7', '--yes'], { from: 'user' });

    expect(executeClear).toHaveBeenCalledWith(expect.objectContaining({ olderThan: 7, yes: true }));
  });

  it('sessions purge --older-than rejects a non-integer value via the spec parser', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);
    program.exitOverride();

    // The `--older-than` OptionSpec carries a pure validating `parse`
    // (parseOlderThanDays); a non-numeric value throws at parse time, before the
    // handler runs, so executeClear is never reached.
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      await expect(
        program.parseAsync(['sessions', 'purge', '--older-than', 'soon', '--yes'], {
          from: 'user',
        }),
      ).rejects.toThrow(/Invalid --older-than/);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(executeClear).not.toHaveBeenCalled();
  });

  it('sessions purge --json: emits JSON and skips render', async () => {
    const { ctx, rendered } = makeCtx();
    const program = mount(ctx);

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

// --- configure ----------------------------------------------------------------

describe('configure spec — action body', () => {
  it('configure: invokes executeConfigure and renders the result', async () => {
    const { ctx, rendered } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['configure'], { from: 'user' });
    expect(executeConfigure).toHaveBeenCalled();
    expect(rendered).toHaveLength(1);
  });

  it('configure --json: short-circuits render', async () => {
    const { ctx, rendered } = makeCtx();
    const program = mount(ctx);

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

// --- init ---------------------------------------------------------------------

describe('init spec — action body', () => {
  it('init: invokes executeInit with parsed flags + cwdExplicit=false when default', async () => {
    const { ctx, rendered } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['init'], { from: 'user' });
    expect(executeInit).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(executeInit).mock.calls[0]?.[0] as {
      cwd: string;
      cwdExplicit: boolean;
      json: boolean;
      language?: string;
    };
    expect(callArgs.json).toBe(false);
    expect(callArgs.cwdExplicit).toBe(false);
    expect(rendered).toHaveLength(1);
  });

  it('init: cwdExplicit=true when the pre-action hook stashed it (—cwd typed on the CLI)', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);

    // Simulate the pre-action hook: it stashes `cwdExplicit` on opts after
    // computing `getOptionValueSource('cwd') === 'cli'`.
    topCmd(program, 'init').setOptionValue('cwdExplicit', true);

    await program.parseAsync(['init', '--cwd', '/explicit'], { from: 'user' });
    const callArgs = vi.mocked(executeInit).mock.calls.at(-1)?.[0] as {
      cwd: string;
      cwdExplicit: boolean;
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

    const { ctx, setExitCode } = makeCtx();
    const program = mount(ctx);

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

    const { ctx, setExitCode } = makeCtx();
    const program = mount(ctx);

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

    const { ctx, setExitCode } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['init'], { from: 'user' });
    expect(setExitCode).toHaveBeenCalledWith(2);
  });

  it('init --json: short-circuits render and emits JSON', async () => {
    const { ctx, rendered } = makeCtx();
    const program = mount(ctx);

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

// --- uninstall ----------------------------------------------------------------

describe('uninstall spec — action body', () => {
  it('uninstall: forwards --yes / --dry-run to executeUninstall (user mode by default)', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['uninstall', '--yes', '--dry-run'], { from: 'user' });
    expect(executeUninstall).toHaveBeenCalledWith(
      expect.objectContaining({ yes: true, dryRun: true, project: undefined }),
    );
  });

  it('uninstall --user: forwards explicit user mode', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['uninstall', '--user', '--yes'], { from: 'user' });
    expect(executeUninstall).toHaveBeenCalledWith(
      expect.objectContaining({ yes: true, project: undefined }),
    );
  });

  it('uninstall rejects conflicting --user and --project modes', async () => {
    const { ctx, setExitCode } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['uninstall', '--user', '--project', '--yes'], { from: 'user' });
    expect(executeUninstall).not.toHaveBeenCalled();
    expect(setExitCode).toHaveBeenCalledTimes(1);
  });

  it('uninstall --project (no value): forwards project=true', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['uninstall', '--project', '--yes'], { from: 'user' });
    expect(executeUninstall).toHaveBeenCalledWith(expect.objectContaining({ project: true }));
  });

  it('uninstall --project <path>: forwards project=<path>', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['uninstall', '--project', '/var/opt/some-proj', '--yes'], {
      from: 'user',
    });
    expect(executeUninstall).toHaveBeenCalledWith(
      expect.objectContaining({ project: '/var/opt/some-proj' }),
    );
  });

  it('uninstall --json: short-circuits render', async () => {
    const { ctx, rendered } = makeCtx();
    const program = mount(ctx);

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

// --- host subcommand-group inventory (single source for completion) -----------

describe('buildHostCommandInventory', () => {
  it('derives the sub-subcommand names from the live leaf specs', () => {
    // Builds the group leaves against the inert INVENTORY_CTX (no handler runs)
    // and reads each leaf's `name` — the single source the completion script
    // consumes for the `sessions` / `plugin` sub-subcommand lists (Phase 6 6.2).
    const inventory = buildHostCommandInventory();
    expect(inventory.groupSubcommands.sessions).toEqual(['list', 'show', 'purge']);
    expect(inventory.groupSubcommands.plugin).toEqual(['list', 'add', 'remove', 'sync']);
    expect(inventory.groupSubcommands.tools).toEqual(['list', 'validate', 'install', 'uninstall']);
    // Exactly the two documented action-less groups — no drift.
    expect(Object.keys(inventory.groupSubcommands).sort()).toEqual(['plugin', 'sessions', 'tools']);
  });
});
