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
    Promise.resolve({
      type: 'plugin',
      action: 'list',
      cwd,
      plugins: [],
    } as never),
  ),
  pluginAdd: vi.fn((pkg: string, cwd: string, domain: string | undefined) =>
    Promise.resolve({
      type: 'plugin',
      action: 'add',
      pkg,
      cwd,
      domain,
    } as never),
  ),
  pluginRemove: vi.fn((pkg: string, cwd: string, domain: string | undefined) =>
    Promise.resolve({
      type: 'plugin',
      action: 'remove',
      pkg,
      cwd,
      domain,
    } as never),
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

vi.mock('../commands/session-show.js', () => ({
  executeSessionShow: vi.fn(() => Promise.resolve()),
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
        path: `${args.cwd}/opensip-cli.config.yml`,
        cwd: args.cwd,
        configFilename: 'opensip-cli.config.yml',
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
import {
  buildHostCommandInventory,
  buildToolPluginLeaves,
  buildToolPluginGroups,
  effectiveCwd,
  mountToolPluginGroups,
} from '../commands/host-subcommand-groups.js';
import { executeInit } from '../commands/init.js';
import { pluginAdd, pluginList, pluginRemove, pluginSync } from '../commands/plugin.js';
import { executeSessionShow } from '../commands/session-show.js';
import { executeUninstall } from '../commands/uninstall.js';

import type { CliCommandsContext } from '../commands/shared.js';
import type { CommandResult } from '@opensip-cli/contracts';

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
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitError: vi.fn(),
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
  const program = new Command('opensip');
  mountHostCommands(program, ctx);
  return program;
}

/** Find a top-level command. */
function topCmd(program: Command, name: string): Command {
  const cmd = program.commands.find((c) => c.name() === name);
  if (!cmd) throw new Error(`no command '${name}'`);
  return cmd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- <tool> plugin (domain-bound, mounted under the tool primary) --------------

/** The single-domain layout view a bound `<tool> plugin …` leaf passes into the
 *  pure plugin commands (matching `boundLayouts(ctx, domain)`). */
const FIT_BOUND_LAYOUTS = [{ domain: 'fit', userSubdirs: ['checks', 'recipes'] }];
const SIM_BOUND_LAYOUTS = [{ domain: 'sim', userSubdirs: ['scenarios', 'recipes'] }];

/** Mount stub `fit`/`sim` tool primaries, THEN the host commands — so the
 *  per-tool `plugin` groups mount under those primaries (the real order: tools
 *  first, then host commands). */
function mountWithToolPrimaries(ctx: CliCommandsContext): Command {
  const program = new Command('opensip');
  program.command('fit').description('Run fitness checks');
  program.command('sim').description('Run simulation scenarios');
  mountHostCommands(program, ctx);
  return program;
}

/** Find a `<tool> plugin <leaf>` doubly-nested command. */
function toolPluginCmd(program: Command, toolVerb: string, leaf: string): Command {
  const primary = topCmd(program, toolVerb);
  const pluginGroup = primary.commands.find((c) => c.name() === 'plugin');
  if (!pluginGroup) throw new Error(`no '${toolVerb} plugin' group`);
  const child = pluginGroup.commands.find((c) => c.name() === leaf);
  if (!child) throw new Error(`no '${toolVerb} plugin ${leaf}'`);
  return child;
}

describe('<tool> plugin spec — action bodies (domain-bound)', () => {
  it('effectiveCwd prefers discovered project root, then --cwd, then process cwd', () => {
    expect(
      effectiveCwd({
        cwd: '/explicit/cwd',
        projectContext: {
          scope: 'project',
          projectRoot: '/discovered/root',
          walkedUp: 0,
        },
      }),
    ).toBe('/discovered/root');
    expect(effectiveCwd({ cwd: '/explicit/cwd' })).toBe('/explicit/cwd');
    expect(effectiveCwd({})).toBe(process.cwd());
  });

  it('buildToolPluginGroups derives one plugin parent per contributed layout', () => {
    const { ctx } = makeCtx();

    expect(
      buildToolPluginGroups(ctx).map((group) => ({
        parentVerb: group.parentVerb,
        domain: group.domain,
        description: group.description,
        leaves: group.leaves.map((leaf) => leaf.name),
      })),
    ).toEqual([
      {
        parentVerb: 'fit',
        domain: 'fit',
        description: 'Manage fit extension packs (add, list, remove, sync)',
        leaves: ['list', 'add', 'remove', 'sync'],
      },
      {
        parentVerb: 'sim',
        domain: 'sim',
        description: 'Manage sim extension packs (add, list, remove, sync)',
        leaves: ['list', 'add', 'remove', 'sync'],
      },
    ]);
  });

  it('mountToolPluginGroups skips domains whose primary command is absent', () => {
    const { ctx } = makeCtx();
    const program = new Command('opensip');

    mountToolPluginGroups(program, ctx);

    expect(program.commands).toEqual([]);
  });

  it('plugin leaves fall back to a minimal bound layout when the domain layout is absent', async () => {
    const { ctx } = makeCtx();
    const leaves = buildToolPluginLeaves({ ...ctx, pluginLayouts: [] }, 'audit');
    const list = leaves.find((leaf) => leaf.name === 'list');

    await list?.handler({ cwd: '/fallback/project' }, ctx);

    expect(pluginList).toHaveBeenCalledWith(
      '/fallback/project',
      [{ domain: 'audit', userSubdirs: [] }],
      [],
    );
  });

  it('fit plugin list: invokes pluginList with effectiveCwd + the bound fit layout', async () => {
    const { ctx, rendered } = makeCtx();
    const program = mountWithToolPrimaries(ctx);

    // Attach a projectContext on the leaf to simulate the pre-action hook's
    // mutation — effectiveCwd should prefer it over --cwd.
    toolPluginCmd(program, 'fit', 'list').setOptionValue('projectContext', {
      projectRoot: '/discovered/root',
      scope: 'project',
      walkedUp: 0,
    });

    await program.parseAsync(['fit', 'plugin', 'list'], { from: 'user' });

    // The handler reads the per-run admitted-tool provenance off the entered
    // RunScope and passes it as the 3rd arg; no scope is entered in this unit
    // test, so it is the empty default. The layout is the single bound fit one.
    expect(pluginList).toHaveBeenCalledWith('/discovered/root', FIT_BOUND_LAYOUTS, []);
    expect(rendered).toHaveLength(1);
  });

  it('fit plugin list --json: short-circuits render and uses effectiveCwd with --cwd fallback', async () => {
    const { ctx, rendered } = makeCtx();
    const program = mountWithToolPrimaries(ctx);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      writes.push(String(c));
      return true;
    });
    try {
      await program.parseAsync(['fit', 'plugin', 'list', '--cwd', '/explicit/cwd', '--json'], {
        from: 'user',
      });
    } finally {
      spy.mockRestore();
    }
    expect(pluginList).toHaveBeenCalledWith('/explicit/cwd', FIT_BOUND_LAYOUTS, []);
    expect(rendered).toHaveLength(0);
    expect(writes.join('')).toContain('"action": "list"');
  });

  it('fit plugin add: forwards the positional arg + the bound fit domain (no --domain flag)', async () => {
    const { ctx } = makeCtx();
    const program = mountWithToolPrimaries(ctx);

    await program.parseAsync(['fit', 'plugin', 'add', '@my-co/foo', '--cwd', '/p'], {
      from: 'user',
    });
    expect(pluginAdd).toHaveBeenCalledWith('@my-co/foo', '/p', 'fit', FIT_BOUND_LAYOUTS);
  });

  it('sim plugin remove: forwards the positional arg + the bound sim domain', async () => {
    const { ctx } = makeCtx();
    const program = mountWithToolPrimaries(ctx);

    await program.parseAsync(['sim', 'plugin', 'remove', '@my-co/foo', '--cwd', '/p'], {
      from: 'user',
    });
    expect(pluginRemove).toHaveBeenCalledWith('@my-co/foo', '/p', 'sim', SIM_BOUND_LAYOUTS);
  });

  it('fit plugin sync: forwards the bound fit domain and effectiveCwd', async () => {
    const { ctx } = makeCtx();
    const program = mountWithToolPrimaries(ctx);

    await program.parseAsync(['fit', 'plugin', 'sync', '--cwd', '/p'], {
      from: 'user',
    });
    expect(pluginSync).toHaveBeenCalledWith('/p', 'fit', FIT_BOUND_LAYOUTS);
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

  it('sessions list forwards parsed filters and summary-only mode', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(
      ['sessions', 'list', '--tool', 'fit', '--limit', '2', '--summary-only'],
      { from: 'user' },
    );

    expect(showHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tool: 'fit', limit: 2, summaryOnly: true }),
    );
  });

  it('sessions list --limit rejects a non-positive value via the spec parser', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);
    program.exitOverride();

    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      await expect(
        program.parseAsync(['sessions', 'list', '--limit', '0'], {
          from: 'user',
        }),
      ).rejects.toThrow(/Invalid --limit/);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(showHistory).not.toHaveBeenCalled();
  });

  it('sessions show delegates replay options to executeSessionShow', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(
      [
        'sessions',
        'show',
        'session-1',
        '--tool',
        'fit',
        '--filter',
        'errors-only',
        '--raw',
        '--json',
      ],
      { from: 'user' },
    );

    expect(executeSessionShow).toHaveBeenCalledWith(
      expect.objectContaining({
        replayRegistry: ctx.sessionReplayRegistry,
        ref: 'session-1',
        tool: 'fit',
        json: true,
        filters: ['errors-only'],
        raw: true,
        render: ctx.render,
        emitJson: ctx.emitJson,
        emitRaw: ctx.emitRaw,
        emitError: ctx.emitError,
        setExitCode: ctx.setExitCode,
      }),
    );
  });

  it('sessions show passes an empty filter list when no --filter is supplied', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['sessions', 'show', 'session-1'], {
      from: 'user',
    });

    expect(executeSessionShow).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'session-1', filters: [] }),
    );
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
      await program.parseAsync(['sessions', 'purge', '--json'], {
        from: 'user',
      });
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
      configFilename: 'opensip-cli.config.yml',
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
      configFilename: 'opensip-cli.config.yml',
      created: false,
      partialStateError: {
        state: 'fully-initialized',
        preExistingFiles: [],
        message: 'm',
      },
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
      configFilename: 'opensip-cli.config.yml',
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

    await program.parseAsync(['uninstall', '--yes', '--dry-run'], {
      from: 'user',
    });
    expect(executeUninstall).toHaveBeenCalledWith(
      expect.objectContaining({ yes: true, dryRun: true, project: undefined }),
    );
  });

  it('uninstall --user: forwards explicit user mode', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['uninstall', '--user', '--yes'], {
      from: 'user',
    });
    expect(executeUninstall).toHaveBeenCalledWith(
      expect.objectContaining({ yes: true, project: undefined }),
    );
  });

  it('uninstall rejects conflicting --user and --project modes', async () => {
    const { ctx, setExitCode } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['uninstall', '--user', '--project', '--yes'], {
      from: 'user',
    });
    expect(executeUninstall).not.toHaveBeenCalled();
    expect(setExitCode).toHaveBeenCalledTimes(1);
  });

  it('uninstall --project (no value): forwards project=true', async () => {
    const { ctx } = makeCtx();
    const program = mount(ctx);

    await program.parseAsync(['uninstall', '--project', '--yes'], {
      from: 'user',
    });
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
      await program.parseAsync(['uninstall', '--json', '--yes'], {
        from: 'user',
      });
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
    // consumes for the `sessions` / `tools` sub-subcommand lists (Phase 6 6.2).
    // The retired top-level `plugin` group is GONE; pack ops now mount under
    // each pack-supporting tool primary (`opensip fit plugin …`).
    const inventory = buildHostCommandInventory();
    expect(inventory.groupSubcommands.sessions).toEqual(['list', 'show', 'purge']);
    expect(inventory.groupSubcommands.plugin).toBeUndefined();
    expect(inventory.groupSubcommands.tools).toEqual([
      'list',
      'doctor',
      'create',
      'validate',
      'install',
      'uninstall',
      'data-purge',
    ]);
    expect(inventory.groupSubcommands.config).toEqual(['validate', 'schema']);
    // Exactly the documented action-less groups — no drift.
    expect(Object.keys(inventory.groupSubcommands).sort()).toEqual(['config', 'sessions', 'tools']);
  });
});
