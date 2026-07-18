import {
  EXIT_CODES,
  type CommandResult,
  type StoredSession,
  type ToolSessionReplay,
} from '@opensip-cli/contracts';
import {
  buildToolIdentityIndex,
  currentScope,
  type ToolRegistry,
  type ToolShortId,
} from '@opensip-cli/core';
import { resolveAndReplaySession } from '@opensip-cli/session-store';

import {
  COMMAND_RESULT,
  defineCommand,
  PROJECT_SCOPE,
  type HostSpec,
} from '../host-subcommand-shared.js';
import {
  resolveRegisteredToolFilter,
  validateRegisteredToolFilter,
} from '../tool-filter-validation.js';

import { applyAndVerifyRepair, applyRepair } from './apply.js';
import { previewRepair } from './planner.js';

import type { CliCommandsContext } from '../shared.js';
import type { RepairBuildInput, RepairError } from './types.js';
import type { DataStore } from '@opensip-cli/datastore';

interface RepairCommandOptions {
  readonly _args: readonly string[];
  readonly tool?: ToolShortId;
  readonly signal?: string;
  readonly action?: string;
  readonly force?: boolean;
  readonly verify?: boolean;
}

function errorResult(message: string, code: string): CommandResult {
  return {
    type: 'error',
    message,
    code,
    exitCode: EXIT_CODES.CONFIGURATION_ERROR,
  };
}

function projectRoot(): string {
  const scope = currentScope();
  return scope?.projectContext?.projectRoot ?? process.cwd();
}

function canonicalToolForDisplay(tool: string, registry: ToolRegistry | undefined): string {
  if (registry === undefined) return tool;
  return buildToolIdentityIndex(registry).canonicalForStoredTool(tool);
}

function buildInput(
  session: StoredSession,
  replay: ToolSessionReplay<CommandResult>,
  opts: RepairCommandOptions,
  registry: ToolRegistry | undefined,
): RepairBuildInput {
  return {
    projectRoot: projectRoot(),
    session: {
      id: session.id,
      tool: canonicalToolForDisplay(session.tool, registry),
      cwd: session.cwd,
    },
    signals: replay.envelope.signals,
    selector: opts.signal ?? '',
    ...(opts.action === undefined ? {} : { actionId: opts.action }),
  };
}

async function replaySessionForRepair(
  ctx: CliCommandsContext,
  opts: RepairCommandOptions,
  registry: ToolRegistry | undefined,
): Promise<
  | { readonly ok: true; readonly input: RepairBuildInput }
  | { readonly ok: false; readonly result: CommandResult }
> {
  if (opts.signal === undefined || opts.signal === '') {
    return { ok: false, result: errorResult('repair commands require --signal', 'missing-signal') };
  }
  const invalid = validateRegisteredToolFilter(registry, opts.tool, {
    requiredMessage: 'repair commands require --tool so latest/session replay is unambiguous',
  });
  if (invalid !== undefined)
    return { ok: false, result: errorResult(invalid.message, invalid.code) };
  const replayRegistry = ctx.sessionReplayRegistry;
  if (replayRegistry === undefined) {
    return {
      ok: false,
      result: errorResult('session replay registry is not available', 'replay-unavailable'),
    };
  }

  const layoutTool = resolveRegisteredToolFilter(registry, opts.tool);
  const ref = opts._args[0] ?? '';
  const outcome = await resolveAndReplaySession(ctx.datastore() as DataStore, {
    ref,
    tool: layoutTool,
    replayFor: (tool) => replayRegistry.get(tool)?.replaySession,
  });
  if (!outcome.ok) {
    return { ok: false, result: errorResult(outcome.detail, outcome.reason) };
  }
  return {
    ok: true,
    input: buildInput(outcome.session, outcome.replay, opts, registry),
  };
}

function commandError(ctx: CliCommandsContext, error: RepairError): CommandResult {
  ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
  return errorResult(error.message, error.code);
}

function buildRepairPreviewSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/repair/command-specs.ts',
      declaration: 'buildRepairPreviewSpec',
    },
    name: 'preview',
    description: 'Preview a deterministic repair action from a stored session signal',
    commonFlags: ['json'],
    args: [{ name: 'ref', description: 'Session id, or latest with --tool' }],
    options: [
      {
        flag: '--tool',
        value: '<name>',
        description: 'Tool for the stored session (required)',
        required: true,
      },
      {
        flag: '--signal',
        value: '<selector>',
        description: 'Signal selector: id:<value>, fingerprint:<value>, or index:<zero-based>',
        required: true,
      },
      {
        flag: '--action',
        value: '<id>',
        description: 'Repair action id when the selected signal has multiple actions',
      },
    ],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: async (rawOpts) => {
      const opts = rawOpts as RepairCommandOptions;
      const registry = currentScope()?.tools;
      const replayed = await replaySessionForRepair(ctx, opts, registry);
      if (!replayed.ok) {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return replayed.result;
      }
      const result = previewRepair(replayed.input);
      if (!result.ok) return commandError(ctx, result.error);
      return result.value;
    },
  });
}

function buildRepairApplySpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/repair/command-specs.ts',
      declaration: 'buildRepairApplySpec',
    },
    name: 'apply',
    description: 'Apply a deterministic repair action from a stored session signal',
    commonFlags: ['json'],
    args: [{ name: 'ref', description: 'Session id, or latest with --tool' }],
    options: [
      {
        flag: '--tool',
        value: '<name>',
        description: 'Tool for the stored session (required)',
        required: true,
      },
      {
        flag: '--signal',
        value: '<selector>',
        description: 'Signal selector: id:<value>, fingerprint:<value>, or index:<zero-based>',
        required: true,
      },
      {
        flag: '--action',
        value: '<id>',
        description: 'Repair action id',
        required: true,
      },
      {
        flag: '--force',
        description: 'Bypass git clean-worktree checks; stale file hashes are still refused',
        default: false,
      },
      {
        flag: '--verify',
        description: 'Rerun deterministic checks after applying the repair',
        default: false,
      },
    ],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: async (rawOpts) => {
      const opts = rawOpts as RepairCommandOptions;
      const registry = currentScope()?.tools;
      const replayed = await replaySessionForRepair(ctx, opts, registry);
      if (!replayed.ok) {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return replayed.result;
      }
      if (opts.verify === true) {
        const configPath = currentScope()?.projectContext?.configPath;
        const result = await applyAndVerifyRepair({
          ...replayed.input,
          force: opts.force === true,
          ...(configPath === undefined ? {} : { configPath }),
        });
        if (!result.ok) return commandError(ctx, result.error);
        if (result.value.status === 'refused' || result.value.verification.status !== 'verified') {
          ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        }
        return result.value;
      }

      const result = applyRepair({ ...replayed.input, force: opts.force === true });
      if (!result.ok) return commandError(ctx, result.error);
      if (result.value.status === 'refused') ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
      return result.value;
    },
  });
}

export function buildRepairGroupLeaves(ctx: CliCommandsContext): readonly HostSpec[] {
  return [buildRepairPreviewSpec(ctx), buildRepairApplySpec(ctx)];
}
