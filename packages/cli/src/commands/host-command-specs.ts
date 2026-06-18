/**
 * host-command-specs — the CLI-owned (host) commands expressed as declarative
 * {@link CommandSpec}s, mounted through the SAME `mountCommandSpec` plane the
 * tools use (launch Phase 6).
 *
 * Host commands (`init` / `configure` / `sessions` / `plugin` / `report` /
 * `completion` / `uninstall`) are NOT tool plugins — they don't ride on a
 * `Tool.commandSpecs` and aren't discovered. But making them mount via the same
 * `mountCommandSpec` means the Phase 7 `command-surface-parity` guardrail sees
 * ONE uniform command surface: there is no second, more-privileged
 * raw-Commander path for "blessed" CLI-owned commands.
 *
 * Each spec's handler closes over the per-invocation {@link CliCommandsContext}
 * (render / setExitCode / datastore thunk / pluginLayouts) — the same data the
 * former `register-*.ts` registrars threaded in. The handler signature's `TCtx`
 * is `CliCommandsContext`; the mount layer only reaches for `render` /
 * `setExitCode` (the `command-result` + thrown-`ToolError` arms) — the
 * `signal-envelope` / `live-view` arms are never exercised by a host command, so
 * `CliCommandsContext` is a valid (leaner) `CommandMountContext`.
 *
 * The two action-less subcommand GROUPS (`sessions`, `plugin`) and their leaf
 * specs live in `host-subcommand-groups.ts` (a leaf module that lets
 * `completion.ts` source its sub-subcommand names without a module cycle). This
 * module assembles the TOP-LEVEL specs and mounts the whole surface.
 *
 * Specs are built per-invocation (inside the builders below, not at module
 * load) so the `--cwd` defaults that resolve to `process.cwd()` are evaluated
 * fresh each run — byte-identical to the former
 * `.option(spec, desc, process.cwd())` registrars.
 */

import { EXIT_CODES } from '@opensip-cli/contracts';
import { ConfigurationError, defineCommand, type ProjectContext } from '@opensip-cli/core';

import { composeAndWriteReport } from '../report-compose.js';

import { executeAgentCatalog } from './agent-catalog.js';
import {
  assembleCompletionInventory,
  printCompletionScript,
  type GroupLike,
  type Shell,
  type SpecLike,
} from './completion.js';
import { executeConfigure } from './configure.js';
import { buildHostSubcommandGroups, type HostSpec } from './host-subcommand-groups.js';
import { executeInit } from './init.js';
import { mountCommandSpec } from './mount-command-spec.js';
import { executeUninstall } from './uninstall.js';

import type { CliCommandsContext } from './shared.js';
import type { CliProgram, InitOptions } from '@opensip-cli/contracts';

/** Shared `output` mode for the host commands that return a renderable result. */
const COMMAND_RESULT = 'command-result' as const;

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

interface InitOpts extends InitOptions {
  projectContext?: ProjectContext;
  /** Stashed by the pre-action hook from `getOptionValueSource('cwd') === 'cli'`. */
  cwdExplicit?: boolean;
}

function buildInitSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'init',
    description: 'Scaffold opensip-cli.config.yml + example checks/scenarios for your project',
    // `--cwd` here matches the registry text ("Target directory"); `--json` /
    // `--debug` match the registry too, so they ride the common-flag path.
    commonFlags: ['cwd', 'json', 'debug'],
    options: [
      {
        flag: '--language',
        value: '<list>',
        description:
          'Language list (typescript|rust|python|go|java|cpp), repeatable or comma-separated. Default: detect from filesystem markers.',
        arrayDefault: [],
        parse: (val, prev) => [...(prev as string[]), val],
      },
      {
        flag: '--keep',
        description: 'Re-scaffold example files. Preserve any custom files in opensip-cli/.',
        default: false,
      },
      {
        flag: '--remove',
        description: 'Delete opensip-cli/ entirely, then scaffold fresh.',
        default: false,
      },
    ],
    scope: 'none',
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as InitOpts;
      // `cwdExplicit` is stashed on opts by the pre-action hook (the single
      // source for "was --cwd typed on the CLI?"); the former register-init
      // recomputed `cmd.getOptionValueSource('cwd') === 'cli'` on its own
      // Commander command — identical, since the hook's actionCommand IS init.
      const result = executeInit({
        ...opts,
        cwdExplicit: opts.cwdExplicit === true,
        toolScaffolds: ctx.toolScaffolds,
      });
      // Exit 2 for any non-success path the user can act on: ambiguous-language
      // detection, partial-state refusal, mutex flag error, inside-existing-
      // project refusal.
      if (
        result.ambiguousLanguageError ||
        result.partialStateError ||
        result.insideExistingProject
      ) {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
      }
      return result;
    },
  });
}

// ---------------------------------------------------------------------------
// configure
// ---------------------------------------------------------------------------

function buildConfigureSpec(): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'configure',
    description: 'Set up OpenSIP Cloud API key',
    commonFlags: ['json', 'debug'],
    scope: 'none',
    output: COMMAND_RESULT,
    handler: () => executeConfigure(),
  });
}

// ---------------------------------------------------------------------------
// report (CLI-owned composition root)
// ---------------------------------------------------------------------------

function buildReportSpec(): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'report',
    description: 'Generate the cross-tool HTML report and open it in your browser',
    commonFlags: ['json'],
    options: [
      {
        flag: '--no-open',
        description: 'Write the report but do not launch a browser',
        negatable: true,
      },
    ],
    scope: 'project',
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as { open: boolean; json: boolean };
      // Commander stores `--no-open` as `opts.open === false`; default true.
      // In `--json` mode we never launch a browser (machine-output contract).
      return composeAndWriteReport({ open: opts.open && !opts.json });
    },
  });
}

// ---------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------

function buildCompletionSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'completion',
    description: 'Print a shell-completion script (bash | zsh | fish)',
    commonFlags: [],
    // Empty description: the former `.command('completion <shell>')` declared
    // the positional inline with no help text — no "Arguments:" block. Keeping
    // it empty preserves the byte-identical --help.
    args: [{ name: 'shell', description: '' }],
    scope: 'none',
    // The handler writes the completion script straight to stdout (no Ink) and
    // owns its own exit-code decision — the documented raw-stream exception.
    output: 'raw-stream',
    rawStreamReason: 'completion-script',
    handler: (rawOpts) => {
      const opts = rawOpts as { _args: string[] };
      const shell = opts._args[0];
      const normalized = shell.toLowerCase();
      if (normalized !== 'bash' && normalized !== 'zsh' && normalized !== 'fish') {
        process.stderr.write(`Unsupported shell: ${shell}. Expected one of: bash, zsh, fish.\n`);
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return;
      }
      // Derive the completion surface from the live specs: the tool commands
      // (supplied by the composition root via `ctx.toolCommandSpecs`), the
      // top-level host commands, and the action-less groups. Single source of
      // truth — the emitted script tracks the real command surface.
      //
      // The host surface is read via {@link buildHostCompletionSurface}, NOT
      // `buildTopLevelHostSpecs`: that assembly includes `buildCompletionSpec`,
      // so calling it from this handler would form a `buildCompletionSpec →
      // buildTopLevelHostSpecs → buildCompletionSpec` call cycle. The surface
      // helper derives the same `SpecLike` views WITHOUT rebuilding the
      // completion spec (it contributes a static, options-free descriptor for
      // itself), keeping the dependency one-directional.
      const host = buildHostCompletionSurface(ctx);
      const inventory = assembleCompletionInventory({
        toolSpecs: ctx.toolCommandSpecs ?? [],
        hostSpecs: host.specs,
        groups: host.groups,
      });
      printCompletionScript(normalized satisfies Shell, inventory);
    },
  });
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

interface UninstallOpts {
  yes?: boolean;
  dryRun?: boolean;
  user?: boolean;
  project?: string | boolean;
  purge?: boolean;
  json?: boolean;
  projectContext?: ProjectContext;
}

function buildUninstallSpec(): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'uninstall',
    description:
      'Remove user-level config at ~/.opensip-cli/ (cloud API key, defaults). Use --project to remove project-local state instead.',
    commonFlags: [],
    options: [
      { flag: '-y, --yes', description: 'Skip confirmation prompt', default: false },
      {
        flag: '--dry-run',
        description: 'Print what would be removed; take no action',
        default: false,
      },
      {
        flag: '--user',
        description: 'Remove user-level config at ~/.opensip-cli/ (default mode)',
        default: false,
      },
      {
        flag: '--project',
        value: '[path]',
        description:
          'Remove project-local runtime state at [path] (defaults to cwd). User content + config preserved unless --purge.',
      },
      {
        flag: '--purge',
        description:
          'With --project, also remove user-authored content and opensip-cli.config.yml (DESTRUCTIVE)',
        default: false,
      },
      { flag: '--json', description: 'Output structured JSON', default: false },
    ],
    scope: 'none',
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as UninstallOpts;
      if (opts.user === true && opts.project !== undefined) {
        throw new ConfigurationError('uninstall: --user and --project are mutually exclusive.');
      }
      // Commander passes `true` when the flag is present without a value, a
      // string when given a value, or undefined when omitted.
      let project: string | true | undefined;
      if (opts.project === true) project = true;
      else if (typeof opts.project === 'string') project = opts.project;
      return executeUninstall({
        yes: opts.yes,
        dryRun: opts.dryRun,
        project,
        purge: opts.purge,
        projectContext: opts.projectContext,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// agent-catalog (agent-first discovery surface)
// ---------------------------------------------------------------------------

function buildAgentCatalogSpec(): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'agent-catalog',
    description:
      'Structured catalog of agent-friendly commands, patterns, and output shapes (JSON preferred). ' +
      'Primary surface for AI agents to bootstrap usage of sessions, filtering, and historical results.',
    commonFlags: ['json'],
    scope: 'none',
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as { json?: boolean };
      return executeAgentCatalog({ json: opts.json });
    },
  });
}

// ---------------------------------------------------------------------------
// Assembly + mount
// ---------------------------------------------------------------------------

/**
 * The `completion` command's own completion surface — a static, options-free
 * `SpecLike`. The command declares `commonFlags: []` and no options (only a
 * positional `<shell>` arg, which is not a flag), so this descriptor is an
 * exact, drift-free stand-in for it in the inventory. Hand-declaring it here
 * (rather than calling `buildCompletionSpec`) is what keeps the completion
 * handler from depending back on its own builder — breaking the
 * `buildCompletionSpec → buildTopLevelHostSpecs → buildCompletionSpec` cycle at
 * the root rather than suppressing it.
 */
const COMPLETION_SELF_SPEC: SpecLike = { name: 'completion', commonFlags: [] };

/**
 * The top-level host specs EXCEPT `completion`. The shared leaf both
 * {@link buildTopLevelHostSpecs} (which splices the completion spec back in at
 * its canonical position) and {@link buildHostCompletionSurface} depend on. It
 * calls neither {@link buildCompletionSpec} nor `buildTopLevelHostSpecs`, so
 * neither caller can form a call cycle back through the completion handler.
 */
function buildNonCompletionHostSpecs(ctx: CliCommandsContext): readonly HostSpec[] {
  return [
    buildInitSpec(ctx),
    buildReportSpec(),
    buildConfigureSpec(),
    buildAgentCatalogSpec(),
    buildUninstallSpec(),
  ];
}

/**
 * The host portion of the completion inventory: the `SpecLike` views of every
 * top-level host command and the action-less groups. The completion command's
 * own surface is the static {@link COMPLETION_SELF_SPEC} stand-in; every OTHER
 * host command is read from its live spec (so its flags can't drift). Consumed
 * by the `completion` handler INSTEAD of {@link buildTopLevelHostSpecs}, so the
 * handler never depends back on {@link buildCompletionSpec}.
 *
 * Order is irrelevant here — the inventory subcommand list is sorted — so the
 * static completion descriptor is simply appended.
 */
function buildHostCompletionSurface(ctx: CliCommandsContext): {
  readonly specs: readonly SpecLike[];
  readonly groups: readonly GroupLike[];
} {
  return {
    specs: [...buildNonCompletionHostSpecs(ctx), COMPLETION_SELF_SPEC],
    groups: buildHostSubcommandGroups(ctx),
  };
}

/**
 * Build the top-level (non-grouped) host command specs. Exported so tests can
 * inspect the host command surface that the host mounts (single source). The
 * `completion` spec keeps its canonical position (after `configure`, before
 * `uninstall`) so the mounted command order — and thus `--help` ordering — is
 * byte-identical to before the cycle-breaking split.
 */
export function buildTopLevelHostSpecs(ctx: CliCommandsContext): readonly HostSpec[] {
  return [
    buildInitSpec(ctx),
    buildReportSpec(),
    buildConfigureSpec(),
    buildAgentCatalogSpec(),
    buildCompletionSpec(ctx),
    buildUninstallSpec(),
  ];
}

/**
 * Mount every host command onto `program` through the shared `mountCommandSpec`
 * plane. Top-level specs mount directly; each subcommand group becomes a raw
 * action-less parent (the documented exception) onto which its leaf specs mount
 * via the same `mountCommandSpec`.
 */
export function mountHostCommands(program: CliProgram, ctx: CliCommandsContext): void {
  for (const spec of buildTopLevelHostSpecs(ctx)) {
    mountCommandSpec(program, spec, ctx);
  }
  for (const group of buildHostSubcommandGroups(ctx)) {
    const parent = program.command(group.name).description(group.description);
    for (const leaf of group.leaves) {
      mountCommandSpec(parent, leaf, ctx);
    }
  }
}
