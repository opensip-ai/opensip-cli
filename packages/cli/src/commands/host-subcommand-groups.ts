// @fitness-ignore-file file-length-limit -- deliberate single cycle-free leaf module: it houses BOTH host subcommand groups' leaf specs (sessions + tools) AND the per-tool `plugin` group leaves + the completion inventory together specifically because it must import neither completion.ts nor host-command-specs.ts (see header — splitting would reintroduce the module cycle this file exists to break). Cohesive by design; grew past the 400-line soft limit with the per-leaf CommandSpec builders.
/**
 * host-subcommand-groups — the action-less Commander subcommand GROUPS
 * (`sessions`, `tools`) and their leaf {@link CommandSpec}s, PLUS the
 * DOMAIN-BOUND per-tool `plugin` group leaves (launch Phase 6 + the
 * command-surface-taxonomy "packs under the tool" refinement).
 *
 * Split out of `host-command-specs.ts` for ONE reason: to break a module cycle.
 * The completion-script generator (`completion.ts`) sources its `sessions` /
 * `tools` sub-subcommand NAME lists from the live leaf specs (single source —
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
 * Their LEAVES (`sessions list|purge`, `tools list|install|…`) ARE specs.
 *
 * The PACK-management `plugin {add,list,remove,sync}` ops are NO LONGER a
 * top-level group: they mount as a `plugin` group UNDER each pack-supporting
 * tool primary (`opensip fit plugin …`, `opensip sim plugin …`) via
 * `mountToolPluginGroups`, with the domain pre-bound from the tool (no
 * `--domain` flag). Whole Tool plugins remain `opensip tools …`.
 */

import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  currentScope,
  defineCommand,
  registeredToolShortIds,
  resolveToolFilterToLayoutKey,
  type CommandScopeRequirement,
  type CommandSpec,
  type PluginLayout,
  type ProjectContext,
  type ToolRegistry,
  type ToolShortId,
} from '@opensip-cli/core';

import { executeClear } from './clear.js';
import { showHistory } from './history.js';
import { mountCommandSpec } from './mount-command-spec.js';
import { pluginAdd, pluginList, pluginRemove, pluginSync } from './plugin.js';
import { executeSessionShow } from './session-show.js';
import { buildToolsGroupLeaves } from './tools/index.js';

import type { CliCommandsContext } from './shared.js';
import type { CliProgram } from '@opensip-cli/contracts';
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

/**
 * Validate a user-supplied `--tool` filter against the live tool registry (M3).
 *
 * The session/persistence discriminant is the OPEN `ToolShortId`, so a
 * registered third-party tool's id is a legitimate filter — the former static
 * `choices: ['fit','graph','sim']` Commander enum re-closed that set and denied
 * third-party tools session-list parity. Membership is therefore validated at
 * RUNTIME against the per-run `ToolRegistry` (always entered for host commands)
 * rather than a compile-time enum. Returns `undefined` (valid) or an error
 * detail the caller emits.
 */
function validateToolFilter(
  tool: string | undefined,
): { message: string; code: string } | undefined {
  if (tool === undefined) return undefined;
  const registry = currentScope()?.tools;
  // No registry (isolated tests): fall back to accepting any non-empty id — the
  // datastore simply returns rows for that discriminant (empty when none).
  if (registry === undefined) return undefined;
  // Membership against the registry's session short ids (the set the
  // `isRegisteredToolId` guard reads); used directly here so the unknown-id
  // branch keeps `tool` typed as the original string for the message below.
  const known = registeredToolShortIds(registry);
  const resolved = resolveToolFilterToLayoutKey(registry, tool) ?? tool;
  if (known.has(tool) || known.has(resolved)) return undefined;
  const knownList = [...known].sort();
  return {
    code: 'unknown-tool',
    message:
      `unknown tool '${tool}'` +
      (knownList.length > 0 ? `; registered tools: ${knownList.join(', ')}` : ''),
  };
}

function buildSessionsListSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'list',
    description: 'List stored sessions',
    commonFlags: ['json'],
    options: [
      {
        flag: '--tool',
        value: '<name>',
        description: 'Filter to one tool (any registered tool id)',
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
      const opts = rawOpts as { tool?: ToolShortId; limit?: number; summaryOnly?: boolean };
      const invalid = validateToolFilter(opts.tool);
      if (invalid) {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return {
          type: 'error',
          message: invalid.message,
          exitCode: EXIT_CODES.CONFIGURATION_ERROR,
        };
      }
      const registry = currentScope()?.tools;
      const layoutFilter =
        registry === undefined || opts.tool === undefined
          ? opts.tool
          : (resolveToolFilterToLayoutKey(registry, opts.tool));
      return showHistory(ctx.datastore() as DataStore, {
        tool: layoutFilter,
        limit: opts.limit,
        summaryOnly: !!opts.summaryOnly,
        ...(registry === undefined ? {} : { registry }),
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
        description: 'Tool for latest, or an optional id sanity check (any registered tool id)',
      },
      {
        flag: '--filter',
        value: '<type>',
        description:
          'Filter replayed signals (repeatable): errors-only | warnings-only | top:<n>. ' +
          'Composable, e.g. --filter errors-only --filter top:20. Agent ergonomics for historical results.',
        arrayDefault: [],
        parse: (val, prev) => [...(prev as string[]), val],
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
        filter?: string[];
        raw?: boolean;
      };
      const ref = opts._args[0];
      const invalid = validateToolFilter(opts.tool);
      if (invalid) {
        if (opts.json === true) {
          ctx.emitError({
            message: invalid.message,
            exitCode: EXIT_CODES.CONFIGURATION_ERROR,
            code: invalid.code,
          });
          return;
        }
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        await ctx.render({
          type: 'error',
          message: invalid.message,
          exitCode: EXIT_CODES.CONFIGURATION_ERROR,
        });
        return;
      }
      const filters = normalizeFilterOption(opts.filter);
      const registry = currentScope()?.tools;
      const layoutTool =
        registry === undefined || opts.tool === undefined
          ? opts.tool
          : (resolveToolFilterToLayoutKey(registry, opts.tool));
      await executeSessionShow({
        replayRegistry: ctx.sessionReplayRegistry,
        ref,
        tool: layoutTool,
        json: opts.json,
        filters,
        raw: opts.raw,
        render: ctx.render,
        emitJson: ctx.emitJson,
        emitRaw: ctx.emitRaw,
        emitError: ctx.emitError,
        setExitCode: ctx.setExitCode,
        ...(registry === undefined ? {} : { registry }),
      });
    },
  });
}

/**
 * Normalize the repeatable `--filter` option (Commander yields a string for one
 * occurrence, a string[] for many, undefined for none) into a uniform
 * `string[] | undefined` for `executeSessionShow`.
 */
function normalizeFilterOption(filter: string | string[] | undefined): string[] | undefined {
  if (Array.isArray(filter)) return filter;
  if (filter) return [filter];
  return undefined;
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
// <tool> plugin {list,add,remove,sync} — DOMAIN-BOUND extension-pack ops
// ---------------------------------------------------------------------------
//
// The pack ops are mounted UNDER each pack-supporting tool primary
// (`opensip fit plugin …`, `opensip sim plugin …`) by `mountToolPluginGroups`,
// with the `domain` PRE-BOUND from that tool. There is no top-level
// `opensip plugin` command and no `--domain`/`--type` flag: the tool the
// subcommand hangs off of IS the domain. Whole Tool plugins are managed by
// `opensip tools …`, never here.

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

/** The single-domain layout view passed to the pure plugin commands so a
 *  bound `<tool> plugin …` op only ever touches its own domain. Resolved from
 *  the host's contributed `pluginLayouts` (so the domain is a real layout, not
 *  an arbitrary string); falls back to a minimal layout if the tool's full
 *  layout is somehow absent. */
function boundLayouts(ctx: CliCommandsContext, domain: string): readonly PluginLayout[] {
  const match = ctx.pluginLayouts.find((l) => l.domain === domain);
  return match ? [match] : [{ domain, userSubdirs: [] }];
}

function buildPluginListSpec(ctx: CliCommandsContext, domain: string): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'list',
    description: `List installed ${domain} packs`,
    commonFlags: ['json'],
    options: [pluginCwdOption()],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as PluginCwdOpts;
      // Per-run admitted-tool provenance is on the entered RunScope (stamped by
      // the bootstrap); read it here and pass it into the pure `pluginList`,
      // scoped to this tool's own domain.
      return pluginList(
        effectiveCwd(opts),
        boundLayouts(ctx, domain),
        currentScope()?.toolProvenance ?? [],
      );
    },
  });
}

function buildPluginAddSpec(ctx: CliCommandsContext, domain: string): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'add',
    description: `Install a ${domain} pack and record it in opensip-cli.config.yml`,
    commonFlags: ['json'],
    options: [pluginCwdOption()],
    // Empty description: the former `.command('add <package>')` declared the
    // positional inline with no help text, so Commander rendered no "Arguments:"
    // block. Keeping it empty preserves the byte-identical --help.
    args: [{ name: 'package', description: '' }],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as PluginCwdOpts & { _args: string[] };
      const packageName = opts._args[0];
      // Domain is bound from the tool primary — no `--domain` flag.
      return pluginAdd(packageName, effectiveCwd(opts), domain, boundLayouts(ctx, domain));
    },
  });
}

function buildPluginRemoveSpec(ctx: CliCommandsContext, domain: string): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'remove',
    description: `Uninstall a ${domain} pack and remove it from opensip-cli.config.yml`,
    commonFlags: ['json'],
    options: [pluginCwdOption()],
    // Empty description — see the plugin-add note above (byte-identical --help).
    args: [{ name: 'package', description: '' }],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as PluginCwdOpts & { _args: string[] };
      const packageName = opts._args[0];
      return pluginRemove(packageName, effectiveCwd(opts), domain, boundLayouts(ctx, domain));
    },
  });
}

function buildPluginSyncSpec(ctx: CliCommandsContext, domain: string): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'sync',
    description: `Install every ${domain} pack declared in opensip-cli.config.yml (post-clone bootstrap)`,
    commonFlags: ['json'],
    options: [pluginCwdOption()],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as PluginCwdOpts;
      return pluginSync(effectiveCwd(opts), domain, boundLayouts(ctx, domain));
    },
  });
}

/**
 * Build the four domain-bound `plugin` leaf specs for ONE pack-supporting tool
 * (`add`/`list`/`remove`/`sync`, all scoped to `domain`). Shared by the mount
 * path (`mountToolPluginGroups`), the command-scope index, and the completion
 * inventory so the three derive the SAME leaves.
 */
export function buildToolPluginLeaves(
  ctx: CliCommandsContext,
  domain: string,
): readonly HostSpec[] {
  return [
    buildPluginListSpec(ctx, domain),
    buildPluginAddSpec(ctx, domain),
    buildPluginRemoveSpec(ctx, domain),
    buildPluginSyncSpec(ctx, domain),
  ];
}

/** One pack-supporting tool's `plugin` group: the tool's primary verb + the
 *  action-less `plugin` parent + the four domain-bound leaves. */
export interface ToolPluginGroup {
  /** Canonical primary verb (`fitness`/`simulation`). */
  readonly parentVerb: string;
  /** CLI aliases for the primary verb (`fit`/`sim`). */
  readonly parentAliases: readonly string[];
  /** @deprecated Use {@link parentVerb} — kept for completion inventory compat. */
  readonly toolVerb: string;
  /** Plugin layout domain / config pin key (`fit`/`sim`). */
  readonly domain: string;
  readonly description: string;
  readonly leaves: readonly HostSpec[];
}

/**
 * Derive the per-tool `plugin` groups from the host's contributed
 * `pluginLayouts` — one group per pack-supporting domain (fit/sim). A tool with
 * no `pluginLayout` (e.g. `graph`) contributes none, so it gets no `plugin`
 * group. The single source the mount path + scope index + completion all read.
 */
export function buildToolPluginGroups(
  ctx: CliCommandsContext,
  registry?: ToolRegistry,
): readonly ToolPluginGroup[] {
  return ctx.pluginLayouts.map((layout) => {
    const tool = registry
      ?.list()
      .find((candidate) => candidate.pluginLayout?.domain === layout.domain);
    const parentVerb = tool?.metadata.name ?? layout.domain;
    const parentAliases = tool?.identity.aliases ?? [];
    return {
      parentVerb,
      parentAliases,
      toolVerb: parentVerb,
      domain: layout.domain,
      description: `Manage ${layout.domain} extension packs (add, list, remove, sync)`,
      leaves: buildToolPluginLeaves(ctx, layout.domain),
    };
  });
}

/**
 * Mount each per-tool `plugin` group UNDER its pack-supporting tool primary
 * (`opensip fit plugin …`), domain pre-bound from the tool. The host derives the
 * groups from the contributed `pluginLayouts` (fit/sim; graph has none, so no
 * group). The tool primary must already be mounted — it is, because the
 * composition root mounts tools before the host commands; a domain whose primary
 * is absent (isolated host-only tests) is skipped (nowhere to hang it).
 */
export function mountToolPluginGroups(
  program: CliProgram,
  ctx: CliCommandsContext,
  registry?: ToolRegistry,
): void {
  for (const group of buildToolPluginGroups(ctx, registry)) {
    const primary = program.commands.find((c) => c.name() === group.parentVerb);
    if (primary === undefined) continue; // no tool primary mounted (host-only tests)
    const parent = primary.command('plugin').description(group.description);
    for (const leaf of group.leaves) {
      mountCommandSpec(parent, leaf, ctx);
    }
  }
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
export const HOST_SUBCOMMAND_GROUPS: readonly string[] = ['sessions', 'tools'] as const;

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
  emitRaw: () => {
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
