/**
 * host-subcommand-groups — the action-less Commander subcommand GROUPS
 * (`sessions`, `plugin`) and their leaf {@link CommandSpec}s (release 2.11.0
 * Phase 6).
 *
 * Split out of `host-command-specs.ts` for ONE reason: to break a module cycle.
 * The completion-script generator (`completion.ts`) sources its `plugin` /
 * `sessions` sub-subcommand NAME lists from the live leaf specs (single source —
 * Phase 6 Task 6.2), so it must import the group inventory. The
 * `host-command-specs.ts` module, in turn, imports `printCompletionScript` from
 * `completion.ts` for the `completion` command's handler. Housing the GROUP
 * leaves + inventory here (a module that imports NEITHER `completion.ts` nor
 * `host-command-specs.ts`) lets both depend on this leaf module without a cycle.
 *
 * The two parents are action-less GROUPS — a parent with no action body is not
 * a single mountable `CommandSpec`, so it stays a raw `program.command(name)`
 * shell (the FINITE, NAMED documented exceptions for the Phase 7
 * `command-surface-parity` guardrail's allow-list, see {@link HOST_SUBCOMMAND_GROUPS}).
 * Their LEAVES (`sessions list|purge`, `plugin list|add|remove|sync`) ARE specs.
 */

import {
  defineCommand,
  type CommandScopeRequirement,
  type CommandSpec,
  type ProjectContext,
  type ToolShortId,
} from '@opensip-cli/core';

import { executeClear } from './clear.js';
import { showHistory } from './history.js';
import { pluginAdd, pluginList, pluginRemove, pluginSync } from './plugin.js';
import { executeSessionShow } from './session-show.js';
import { buildToolsGroupLeaves } from './tools/index.js';

import type { CliCommandsContext } from './shared.js';
import type { DataStore } from '@opensip-cli/datastore';

/** A host command spec — handler receives the {@link CliCommandsContext}. */
export type HostSpec = CommandSpec<unknown, CliCommandsContext>;

/** Every grouped leaf needs the entered project scope (datastore / project
 *  context). Named once so the discriminant isn't restated per spec. */
const PROJECT_SCOPE: CommandScopeRequirement = 'project';

/** The `command-result` output mode, named once (the leaves all share it). */
const COMMAND_RESULT: CommandSpec['output'] = 'command-result';

const RAW_STREAM: CommandSpec['output'] = 'raw-stream';

/** Prefer the discovered project root; fall back to literal cwd; finally process.cwd(). */
export function effectiveCwd(opts: { cwd?: string; projectContext?: ProjectContext }): string {
  return opts.projectContext?.projectRoot ?? opts.cwd ?? process.cwd();
}

// ---------------------------------------------------------------------------
// sessions list / purge
// ---------------------------------------------------------------------------

function buildSessionsListSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'list',
    description: 'List stored sessions',
    commonFlags: ['json'],
    options: [
      {
        flag: '--tool',
        value: '<name>',
        description: 'Filter to one tool',
        choices: ['fit', 'graph', 'sim'],
      },
      {
        flag: '--limit',
        value: '<n>',
        description: 'Maximum sessions to return',
        parse: parsePositiveInt,
      },
      {
        flag: '--summary-only',
        description:
          'Omit heavy per-session payloads (agent friendly; showCommand and lightweight summary remain). ' +
          'Pairs well with --json for lean "menu" of historical results.',
      },
    ],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as { tool?: ToolShortId; limit?: number; 'summary-only'?: boolean };
      return showHistory(ctx.datastore() as DataStore, {
        tool: opts.tool,
        limit: opts.limit,
        summaryOnly: !!opts['summary-only'],
      });
    },
  });
}

function buildSessionsShowSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'show',
    description: 'Display a stored session result',
    commonFlags: ['json'],
    args: [{ name: 'ref', description: 'Session id, or latest with --tool' }],
    options: [
      {
        flag: '--tool',
        value: '<name>',
        description: 'Tool for latest, or an optional id sanity check',
        choices: ['fit', 'graph', 'sim'],
      },
      {
        flag: '--filter',
        value: '<type>',
        description:
          'Filter replayed signals (repeatable): errors-only | warnings-only | top:<n>. ' +
          'Composable, e.g. --filter errors-only --filter top:20. Agent ergonomics for historical results.',
      },
      {
        flag: '--raw',
        description:
          'With --json: emit the inner payload (session + envelope + metadata) without the outer CommandResult wrapper. ' +
          'Ideal for agents that want the smallest possible response.',
      },
    ],
    scope: PROJECT_SCOPE,
    output: RAW_STREAM,
    rawStreamReason: 'session-replay',
    handler: async (rawOpts) => {
      const opts = rawOpts as {
        _args: string[];
        tool?: ToolShortId;
        json?: boolean;
        filter?: string | string[];
        raw?: boolean;
      };
      const ref = opts._args[0];
      const filters = Array.isArray(opts.filter) ? opts.filter : opts.filter ? [opts.filter] : undefined;
      await executeSessionShow({
        replayRegistry: ctx.sessionReplayRegistry,
        ref,
        tool: opts.tool,
        json: opts.json,
        filters,
        raw: opts.raw,
        render: ctx.render,
        emitJson: ctx.emitJson,
        emitError: ctx.emitError,
        setExitCode: ctx.setExitCode,
      });
    },
  });
}

/**
 * Validating coercion for `sessions list --limit <n>`.
 *
 * @throws {Error} When the raw value is not a positive integer.
 */
function parsePositiveInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid --limit value: '${raw}'. Must be a positive integer.`);
  }
  return n;
}

/**
 * Validating coercion for `sessions purge --older-than <days>` — identical to
 * the former inline argParser. A named declaration (not an inline lambda) so the
 * `@throws` contract below is documented.
 *
 * @throws {Error} When the raw value is not a non-negative integer.
 */
function parseOlderThanDays(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`Invalid --older-than value: '${raw}'. Must be a non-negative integer.`);
  }
  return n;
}

function buildSessionsPurgeSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'purge',
    description:
      'Delete session rows from the project-local SQLite store (opensip-cli/.runtime/datastore.sqlite)',
    commonFlags: ['json'],
    options: [
      {
        flag: '--older-than',
        value: '<days>',
        description: 'Only delete sessions older than N days',
        // Pure validating coercion — identical to the former inline argParser.
        parse: parseOlderThanDays,
      },
      { flag: '-y, --yes', description: 'Skip confirmation prompt', default: false },
    ],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as { olderThan?: number; yes: boolean };
      return executeClear({
        olderThan: opts.olderThan,
        yes: opts.yes,
        datastore: ctx.datastore() as DataStore,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// plugin list / add / remove / sync
// ---------------------------------------------------------------------------

/** The shared `--cwd <path>` option for the plugin leaves. Its description is
 *  "Project root" (NOT the registry's "Target directory"), so it is declared as
 *  a per-command OptionSpec rather than the `cwd` common flag — preserving the
 *  byte-identical help text. The default resolves per-invocation (the builders
 *  run on each `registerCliCommands` call). */
function pluginCwdOption() {
  return {
    flag: '--cwd',
    value: '<path>',
    description: 'Project root',
    default: process.cwd(),
  } as const;
}

interface PluginCwdOpts {
  cwd?: string;
  projectContext?: ProjectContext;
}

function buildPluginListSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'list',
    description: 'List installed plugins',
    commonFlags: ['json'],
    options: [pluginCwdOption()],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as PluginCwdOpts;
      return pluginList(effectiveCwd(opts), ctx.pluginLayouts);
    },
  });
}

function buildPluginAddSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'add',
    description: 'Install a plugin (fit/sim pack → project config; tool → user-global by default)',
    commonFlags: ['json'],
    options: [
      {
        flag: '--domain',
        value: '<fit|sim|tool>',
        description: 'Target domain (default: inferred; tool plugins auto-detected by marker)',
      },
      {
        flag: '--project',
        description: 'For a tool plugin, install project-local (.runtime/) instead of user-global',
        default: false,
      },
      pluginCwdOption(),
    ],
    // Empty description: the former `.command('add <package>')` declared the
    // positional inline with no help text, so Commander rendered no "Arguments:"
    // block. Keeping it empty preserves the byte-identical --help.
    args: [{ name: 'package', description: '' }],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as PluginCwdOpts & {
        domain?: string;
        project?: boolean;
        _args: string[];
      };
      const packageName = opts._args[0];
      return pluginAdd(packageName, effectiveCwd(opts), opts.domain, ctx.pluginLayouts, {
        project: opts.project,
      });
    },
  });
}

function buildPluginRemoveSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'remove',
    description: 'Uninstall a plugin (and remove from opensip-cli.config.yml for fit/sim packs)',
    commonFlags: ['json'],
    options: [
      {
        flag: '--domain',
        value: '<fit|sim|tool>',
        description: 'Target domain (default: inferred from package name)',
      },
      {
        flag: '--project',
        description: 'For a tool plugin, target the project-local install instead of user-global',
        default: false,
      },
      pluginCwdOption(),
    ],
    // Empty description — see the plugin-add note above (byte-identical --help).
    args: [{ name: 'package', description: '' }],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as PluginCwdOpts & {
        domain?: string;
        project?: boolean;
        _args: string[];
      };
      const packageName = opts._args[0];
      return pluginRemove(packageName, effectiveCwd(opts), opts.domain, ctx.pluginLayouts, {
        project: opts.project,
      });
    },
  });
}

function buildPluginSyncSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'sync',
    description: 'Install every plugin declared in opensip-cli.config.yml (post-clone bootstrap)',
    commonFlags: ['json'],
    options: [
      { flag: '--domain', value: '<fit|sim>', description: 'Sync only one domain' },
      pluginCwdOption(),
    ],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as PluginCwdOpts & { domain?: string };
      return pluginSync(effectiveCwd(opts), opts.domain, ctx.pluginLayouts);
    },
  });
}

// ---------------------------------------------------------------------------
// Group assembly + documented-exception list + inventory
// ---------------------------------------------------------------------------

/** One subcommand-group parent: a raw action-less `program.command(name)`
 *  shell + the leaf specs that mount onto it. */
export interface HostSubcommandGroup {
  readonly name: string;
  readonly description: string;
  readonly leaves: readonly HostSpec[];
}

/**
 * The action-less Commander subcommand GROUPS that legitimately cannot be a
 * single {@link CommandSpec} — they have no action body, only sub-subcommands.
 * This is the FINITE, NAMED set the Phase 7 `command-surface-parity` guardrail
 * allow-lists as documented host exceptions. Every other host command IS a spec.
 */
export const HOST_SUBCOMMAND_GROUPS: readonly string[] = ['sessions', 'plugin', 'tools'] as const;

/**
 * Build the subcommand-group parents with their leaf specs. The mounter turns
 * each into a raw parent `program.command(name)` plus `mountCommandSpec(parent,
 * leaf)` for each leaf.
 */
export function buildHostSubcommandGroups(ctx: CliCommandsContext): readonly HostSubcommandGroup[] {
  return [
    {
      name: 'sessions',
      description: 'Manage session data',
      leaves: [buildSessionsListSpec(ctx), buildSessionsShowSpec(ctx), buildSessionsPurgeSpec(ctx)],
    },
    {
      name: 'plugin',
      description: 'Manage project-local plugins (add, list, remove, sync)',
      leaves: [
        buildPluginListSpec(ctx),
        buildPluginAddSpec(ctx),
        buildPluginRemoveSpec(ctx),
        buildPluginSyncSpec(ctx),
      ],
    },
    {
      name: 'tools',
      description: 'Manage whole Tool plugins (list, validate, install, uninstall)',
      leaves: buildToolsGroupLeaves(ctx),
    },
  ];
}

/**
 * A no-op {@link CliCommandsContext} used purely to BUILD the group leaf specs
 * so their `name` can be read for the completion-script sub-subcommand
 * inventory. The handlers are never invoked here — we only inspect the static
 * declarations — so the render/datastore/exit members are inert stubs.
 */
const INVENTORY_CTX: CliCommandsContext = {
  setExitCode: () => {
    /* inert — inventory builds never dispatch a handler */
  },
  render: () => Promise.resolve(),
  emitJson: () => {
    /* inert — inventory builds never dispatch a handler */
  },
  emitError: () => {
    /* inert — inventory builds never dispatch a handler */
  },
  pluginLayouts: [],
  toolScaffolds: [],
  // eslint-disable-next-line unicorn/no-useless-undefined -- explicit no-store sentinel matching the `datastore` thunk contract (returns `unknown`; consumers cast to `DataStore | undefined`).
  datastore: () => undefined,
};

/**
 * The host subcommand-group NAME inventory derived from the live leaf specs —
 * the single source the shell-completion script (`completion.ts`) reads for the
 * `plugin` / `sessions` sub-subcommand names instead of a second hand-maintained
 * list (Phase 6 Task 6.2).
 *
 * NOTE: only the NAME lists are sourced here — the curated per-command flag
 * subsets the completion script offers stay in `completion.ts`, since
 * exhaustively deriving every declared flag would change the emitted script. The
 * common flags themselves already derive from the shared ADR-0021 registry (the
 * same registry the specs' `commonFlags` resolve through), so that half is
 * already single-sourced.
 */
export interface HostCommandInventory {
  /** Sub-subcommand names per group (`{ sessions: ['list','purge'], plugin: [...] }`). */
  readonly groupSubcommands: Readonly<Record<string, readonly string[]>>;
}

/** Build the host subcommand-group name inventory (single source for completion). */
export function buildHostCommandInventory(): HostCommandInventory {
  const groupSubcommands: Record<string, readonly string[]> = {};
  for (const group of buildHostSubcommandGroups(INVENTORY_CTX)) {
    groupSubcommands[group.name] = group.leaves.map((l) => l.name);
  }
  return { groupSubcommands };
}
