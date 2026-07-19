// @fitness-ignore-file module-coupling-fan-out -- host command composition root intentionally assembles independent command leaves and their host seams.
/**
 * host-command-specs — CLI-owned commands as declarative {@link CommandSpec}s,
 * mounted via the same `mountCommandSpec` plane as tools (Phase 6/7 parity).
 * Host commands (`init`, `configure`, `sessions`, `report`, `completion`,
 * `uninstall`, `tools`) are not tool plugins. Action-less groups and per-tool
 * `plugin` leaves live in `host-subcommand-groups.ts`; this module assembles
 * top-level specs. Built per-invocation so `--cwd` defaults stay fresh.
 */

import {
  EXIT_CODES,
  type InitResult,
  type RuntimeAdoptionResult,
  type CliProgram,
  type InitOptions,
} from '@opensip-cli/contracts';
import { currentLogger, currentScope, type ProjectContext } from '@opensip-cli/core';

import { capabilityWorkerCommandSpec } from '../bootstrap/capability-worker/entry.js';
import { buildDatastoreLockContext } from '../bootstrap/state-lock-policy.js';
import { toolCommandWorkerCommandSpec } from '../bootstrap/tool-command-worker-entry.js';

import { buildAuditCommandSpec } from './audit-command-spec.js';
import { type SpecLike } from './completion.js';
import {
  createCompletionCommandSpec,
  type HostCompletionSurface,
} from './host-completion-command-spec.js';
import {
  createAgentCatalogCommandSpec,
  createConfigureCommandSpec,
  createReportCommandSpec,
  createStatusCommandSpec,
  createUninstallCommandSpec,
} from './host-leaf-command-specs.js';
import { defineHostCommand as defineCommand } from './host-runtime-access.js';
import {
  buildHostSubcommandGroups,
  buildToolPluginGroups,
  mountToolPluginGroups,
  type HostSpec,
} from './host-subcommand-groups.js';
import {
  attachOptionalToolRecommendations,
  isOptionalToolRecommendationEligible,
} from './init/optional-tools.js';
import { executeInit, executeInitRecovery } from './init.js';
import { mountCommandSpec } from './mount-command-spec.js';
import { toolsList } from './tools/list.js';

import type { CliCommandsContext } from './shared.js';
import type { CommandActionScopeRunner } from '../bootstrap/command-action-scope-runner.js';

/** Shared `output` mode for the host commands that return a renderable result. */
const COMMAND_RESULT = 'command-result' as const;

/** Static-handler provenance shared by every host command spec in this module. */
const HOST_COMMAND_PACKAGE = 'opensip-cli';
const HOST_COMMAND_SPECS_PATH = 'packages/cli/src/commands/host-command-specs.ts';

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

interface InitOpts extends InitOptions {
  projectContext?: ProjectContext;
  /** Stashed by the pre-action hook from `getOptionValueSource('cwd') === 'cli'`. */
  cwdExplicit?: boolean;
}

function adoptionExitCode(adoption: RuntimeAdoptionResult): number | undefined {
  switch (adoption.status) {
    case 'not-found':
    case 'promoted':
    case 'already-project':
    case 'deduplicated':
    case 'kept-project': {
      return undefined;
    }
    case 'conflict': {
      return adoption.reasonCode === 'destination-unverified'
        ? EXIT_CODES.RUNTIME_ERROR
        : EXIT_CODES.CONFIGURATION_ERROR;
    }
    case 'recovery-required': {
      return adoption.reasonCode === 'operation-interrupted'
        ? EXIT_CODES.CONFIGURATION_ERROR
        : EXIT_CODES.RUNTIME_ERROR;
    }
    case 'busy':
    case 'rolled-back':
    case 'cleanup-pending': {
      return EXIT_CODES.RUNTIME_ERROR;
    }
  }
}

function applyInitExitCode(result: InitResult, ctx: CliCommandsContext): void {
  if (
    result.languageResolutionError !== undefined ||
    result.partialStateError !== undefined ||
    result.authoredStateChangedError !== undefined ||
    result.insideExistingProject !== undefined
  ) {
    ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    return;
  }
  if (result.runtimeAdoption === undefined) return;
  const code = adoptionExitCode(result.runtimeAdoption);
  if (code !== undefined) ctx.setExitCode(code);
}

function initDatastoreLockContext(opts: InitOpts) {
  const cwd = opts.projectContext?.projectRoot ?? opts.cwd;
  return buildDatastoreLockContext(currentScope()?.logger ?? currentLogger(), {
    commandName: 'opensip init',
    cwd,
  });
}

function buildInitSpec(
  ctx: CliCommandsContext,
  execution: 'normal' | 'recovery-only' = 'normal',
): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: HOST_COMMAND_PACKAGE,
      path: HOST_COMMAND_SPECS_PATH,
      declaration: 'buildInitSpec',
    },
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
          'Language list (typescript|rust|python|go|java|cpp), repeatable or comma-separated. Default: accept every detected marker language (polyglot OK). Override to force a set.',
        arrayDefault: [],
        parse: (val, prev) => [...(prev as string[]), val],
      },
      {
        flag: '--keep',
        description:
          'Re-scaffold example files. Preserve existing config and custom files in opensip-cli/.',
        default: false,
      },
      {
        flag: '--remove',
        description:
          'Reset Init-authored files and scaffold fresh. Preserve opensip-cli/.runtime evidence.',
        default: false,
      },
      {
        flag: '--runtime-conflict',
        value: '<policy>',
        choices: ['abort', 'keep-project', 'use-cache'],
        description:
          'Choose runtime authority when evidence conflicts. Default for a new operation: abort; an omitted recovery retry replays the recorded policy.',
      },
    ],
    scope: 'none',
    output: COMMAND_RESULT,
    handler: async (rawOpts) => {
      const opts = rawOpts as InitOpts;
      // `cwdExplicit` is stashed on opts by the pre-action hook (the single
      // source for "was --cwd typed on the CLI?"); the former register-init
      // recomputed `cmd.getOptionValueSource('cwd') === 'cli'` on its own
      // Commander command — identical, since the hook's actionCommand IS init.
      const shared = {
        ...opts,
        cwdExplicit: opts.cwdExplicit === true,
        datastoreLockContext: initDatastoreLockContext(opts),
      };
      let result =
        execution === 'recovery-only'
          ? await executeInitRecovery(shared)
          : await executeInit({
              ...shared,
              toolScaffolds: ctx.toolScaffolds,
            });
      if (
        execution === 'normal' &&
        opts.keep !== true &&
        opts.remove !== true &&
        isOptionalToolRecommendationEligible(result)
      ) {
        const scope = currentScope();
        const inventory = toolsList({
          cwd: result.cwd,
          provenance: scope?.toolProvenance ?? [],
          manifests: scope?.toolManifests ?? [],
        });
        const installedIds = new Set(inventory.tools.map((row) => row.id));
        result = attachOptionalToolRecommendations(result, { installedIds });
        scope?.logger.debug({
          evt: 'cli.init.optional_tools_projected',
          module: 'cli:init',
          languageCount: result.languages?.length ?? 0,
          installedCount: installedIds.size,
          recommendedCount: result.optionalTools?.length ?? 0,
        });
      }
      applyInitExitCode(result, ctx);
      return result;
    },
  });
}

/**
 * Canonical Init grammar with a recovery-only action. The lightweight probe
 * mounts this one spec before Tool discovery whenever a fixed journal exists.
 */
export function buildInitRecoverySpec(ctx: CliCommandsContext): HostSpec {
  return buildInitSpec(ctx, 'recovery-only');
}

// ---------------------------------------------------------------------------
// configure
// ---------------------------------------------------------------------------

function buildConfigureSpec(): HostSpec {
  return createConfigureCommandSpec();
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function buildStatusSpec(): HostSpec {
  return createStatusCommandSpec();
}

/**
 * Host specs whose policy must be known before startup Tool discovery. Kept as
 * a live spec projection so the pre-scan cannot drift into a second command
 * allowlist.
 */
export function buildPreBootstrapInspectionHostSpecs(): readonly HostSpec[] {
  return [buildStatusSpec()];
}

// ---------------------------------------------------------------------------
// report (CLI-owned composition root)
// ---------------------------------------------------------------------------

function buildReportSpec(): HostSpec {
  return createReportCommandSpec();
}

// ---------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------

function buildCompletionSpec(ctx: CliCommandsContext): HostSpec {
  return createCompletionCommandSpec(ctx, () => buildHostCompletionSurface(ctx));
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

function buildUninstallSpec(ctx: CliCommandsContext): HostSpec {
  return createUninstallCommandSpec(ctx);
}

// ---------------------------------------------------------------------------
// agent-catalog (agent-first discovery surface)
// ---------------------------------------------------------------------------

function buildAgentCatalogSpec(ctx: CliCommandsContext): HostSpec {
  return createAgentCatalogCommandSpec(ctx);
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
    buildAuditCommandSpec(ctx),
    buildReportSpec(),
    buildStatusSpec(),
    buildConfigureSpec(),
    buildAgentCatalogSpec(ctx),
    buildUninstallSpec(ctx),
  ];
}

/**
 * The host portion of the completion inventory: the `SpecLike` views of every
 * top-level host command, the action-less groups, and the per-tool `plugin`
 * groups. The completion command's own surface is the static
 * {@link COMPLETION_SELF_SPEC} stand-in; every OTHER host command is read from
 * its live spec (so its flags can't drift). Consumed by the `completion` handler
 * INSTEAD of {@link buildTopLevelHostSpecs}, so the handler never depends back on
 * {@link buildCompletionSpec}.
 */
function buildHostCompletionSurface(ctx: CliCommandsContext): HostCompletionSurface {
  return {
    specs: [...buildNonCompletionHostSpecs(ctx), COMPLETION_SELF_SPEC],
    groups: buildHostSubcommandGroups(ctx),
    toolPluginGroups: buildToolPluginGroups(ctx, ctx.tools).map((g) => ({
      parentVerb: g.parentVerb,
      parentAliases: g.parentAliases,
      leaves: g.leaves.map((l) => ({ name: l.name })),
    })),
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
    buildAuditCommandSpec(ctx),
    buildReportSpec(),
    buildStatusSpec(),
    buildConfigureSpec(),
    buildAgentCatalogSpec(ctx),
    buildCompletionSpec(ctx),
    buildUninstallSpec(ctx),
    // ADR-0054 M4-E internal worker subcommand the dispatch supervisor forks
    // (`opensip __tool-command-worker <spec>`); visibility:'internal' (hidden,
    // still invocable). See its spec's JSDoc in tool-command-worker-entry.ts.
    toolCommandWorkerCommandSpec,
    capabilityWorkerCommandSpec,
  ];
}

/**
 * Mount every host command onto `program` through the shared `mountCommandSpec`
 * plane. Top-level specs mount directly; each subcommand group becomes a raw
 * action-less parent (the documented exception) onto which its leaf specs mount
 * via the same `mountCommandSpec`. Finally, the per-tool `plugin` groups mount
 * UNDER each pack-supporting tool primary via {@link mountToolPluginGroups} —
 * which runs AFTER the tools were mounted (the composition root mounts tools
 * before `registerCliCommands`), so the tool primaries already exist.
 */
export function mountHostCommands(
  program: CliProgram,
  ctx: CliCommandsContext,
  actionScopeRunner?: CommandActionScopeRunner,
): void {
  for (const spec of buildTopLevelHostSpecs(ctx)) {
    mountCommandSpec(program, spec, ctx, {}, actionScopeRunner);
  }
  for (const group of buildHostSubcommandGroups(ctx)) {
    const parent = program.command(group.name).description(group.description);
    for (const leaf of group.leaves) {
      mountCommandSpec(parent, leaf, ctx, {}, actionScopeRunner);
    }
  }
  mountToolPluginGroups(program, ctx, ctx.tools, actionScopeRunner);
}
