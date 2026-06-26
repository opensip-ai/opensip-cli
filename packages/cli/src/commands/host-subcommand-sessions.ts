/**
 * `sessions` subcommand group leaf specs (list / show / purge).
 */

import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  currentScope,
  registeredToolShortIds,
  resolveToolFilterToLayoutKey,
  ValidationError,
  type ToolShortId,
} from '@opensip-cli/core';

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

import type { CliCommandsContext } from './shared.js';
import type { DataStore } from '@opensip-cli/datastore';

function validateToolFilter(
  tool: string | undefined,
): { message: string; code: string } | undefined {
  if (tool === undefined) return undefined;
  const registry = currentScope()?.tools;
  if (registry === undefined) return undefined;
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

function normalizeFilterOption(filter: string | string[] | undefined): string[] | undefined {
  if (Array.isArray(filter)) return filter;
  if (filter) return [filter];
  return undefined;
}

/** @throws {Error} When the raw value is not a positive integer. */
function parsePositiveInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new ValidationError(`Invalid --limit value: '${raw}'. Must be a positive integer.`);
  }
  return n;
}

/** @throws {Error} When the raw value is not a non-negative integer. */
function parseOlderThanDays(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new ValidationError(
      `Invalid --older-than value: '${raw}'. Must be a non-negative integer.`,
    );
  }
  return n;
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
          : resolveToolFilterToLayoutKey(registry, opts.tool);
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
          : resolveToolFilterToLayoutKey(registry, opts.tool);
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

/** Build the three `sessions` group leaf specs. */
export function buildSessionsGroupLeaves(ctx: CliCommandsContext): readonly HostSpec[] {
  return [buildSessionsListSpec(ctx), buildSessionsShowSpec(ctx), buildSessionsPurgeSpec(ctx)];
}
