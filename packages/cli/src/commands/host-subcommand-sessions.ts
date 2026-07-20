/**
 * `sessions` subcommand group leaf specs (list / show / purge).
 */

import { EXIT_CODES } from '@opensip-cli/contracts';
import { currentScope, ValidationError, type ToolShortId } from '@opensip-cli/core';

import { executeClear } from './clear.js';
import { showHistory } from './history.js';
import {
  COMMAND_RESULT,
  defineCommand,
  PROJECT_SCOPE,
  RAW_STREAM,
  type HostSpec,
} from './host-subcommand-shared.js';
import { executeSessionShow } from './session-show.js';
import {
  resolveRegisteredToolFilter,
  validateRegisteredToolFilter,
} from './tool-filter-validation.js';

import type { CliCommandsContext } from './shared.js';
import type { DataStore } from '@opensip-cli/datastore';

function normalizeFilterOption(filter: string | string[] | undefined): string[] | undefined {
  if (Array.isArray(filter)) return filter;
  if (filter) return [filter];
  return undefined;
}

function parseDecimalInteger(raw: string): number | undefined {
  if (!/^\d+$/u.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** @throws {Error} When the raw value is not a positive integer. */
function parsePositiveInt(raw: string): number {
  const n = parseDecimalInteger(raw);
  if (n === undefined || n <= 0) {
    throw new ValidationError(`Invalid --limit value: '${raw}'. Must be a positive integer.`);
  }
  return n;
}

/** @throws {Error} When the raw value is not a non-negative integer. */
function parseOlderThanDays(raw: string): number {
  const n = parseDecimalInteger(raw);
  const cutoff = n === undefined ? Number.NaN : Date.now() - n * 24 * 60 * 60 * 1000;
  if (n === undefined || Number.isNaN(new Date(cutoff).getTime())) {
    throw new ValidationError(
      `Invalid --older-than value: '${raw}'. Must be a non-negative integer within the supported date range.`,
    );
  }
  return n;
}

function buildSessionsListSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/host-subcommand-sessions.ts',
      declaration: 'buildSessionsListSpec',
    },
    name: 'list',
    description: 'List stored sessions',
    // First-run capable: a pre-init run records real evidence in the ephemeral
    // user-cache datastore, so the user must be able to read it back without
    // being forced to initialize the project first.
    noInit: true,
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
      const opts = rawOpts as {
        tool?: ToolShortId;
        limit?: number;
        summaryOnly?: boolean;
      };
      const registry = currentScope()?.tools;
      const invalid = validateRegisteredToolFilter(registry, opts.tool);
      if (invalid) {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return {
          type: 'error',
          message: invalid.message,
          exitCode: EXIT_CODES.CONFIGURATION_ERROR,
        };
      }
      const layoutFilter = resolveRegisteredToolFilter(registry, opts.tool);
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
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/host-subcommand-sessions.ts',
      declaration: 'buildSessionsShowSpec',
    },
    name: 'show',
    description: 'Display a stored session result',
    // First-run capable — see `sessions list`. Replay reads the same ephemeral
    // datastore the pre-init run wrote.
    noInit: true,
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
      const registry = currentScope()?.tools;
      const invalid = validateRegisteredToolFilter(registry, opts.tool);
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
      const layoutTool = resolveRegisteredToolFilter(registry, opts.tool);
      await executeSessionShow({
        replayRegistry: ctx.sessionReplayRegistry,
        ref,
        tool: layoutTool,
        json: opts.json === true,
        filters,
        raw: opts.raw === true,
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

function buildSessionsPurgeSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/host-subcommand-sessions.ts',
      declaration: 'buildSessionsPurgeSpec',
    },
    name: 'purge',
    description:
      'Delete Tool Sessions from the active local evidence store (project runtime or user cache). Preserves Runs, reports, catalogs, and other runtime state. Full removal: opensip uninstall --project',
    // First-run capable — pre-init evidence lives in the user-cache store and
    // must be purgeable without forcing Init. Same active store as list/show.
    noInit: true,
    commonFlags: ['json'],
    options: [
      {
        flag: '--older-than',
        value: '<days>',
        description: 'Only delete sessions older than N days',
        parse: parseOlderThanDays,
      },
      {
        flag: '-y, --yes',
        description: 'Skip confirmation prompt',
        default: false,
      },
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

/** Build the three `sessions` group leaf specs. */
export function buildSessionsGroupLeaves(ctx: CliCommandsContext): readonly HostSpec[] {
  return [buildSessionsListSpec(ctx), buildSessionsShowSpec(ctx), buildSessionsPurgeSpec(ctx)];
}
