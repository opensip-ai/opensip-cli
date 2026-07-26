/**
 * `runs` subcommand group leaf specs (`list` / `show`).
 *
 * Parent Runs are the canonical execution ledger. Tool Sessions remain the
 * replay surface linked from individual RunSteps.
 */

import { ValidationError } from '@opensip-cli/core';

import { hostErrorCatalog } from '../errors/host-error-catalog.js';

import {
  COMMAND_RESULT,
  defineCommand,
  PROJECT_SCOPE,
  type HostSpec,
} from './host-subcommand-shared.js';
import { executeRunsList, executeRunsShow } from './run-history.js';

import type { CliCommandsContext } from './shared.js';
import type { DataStore } from '@opensip-cli/datastore';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const RUN_READ_INPUT = hostErrorCatalog.require('VALIDATION.RUN_READ.INPUT_INVALID');

const DECIMAL_INTEGER = /^\d+$/u;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_STEP_LIMIT = 100;
const DEFAULT_STEP_OFFSET = 0;
const MAX_READ_LIMIT = 500;
const MAX_STEP_OFFSET = Number.MAX_SAFE_INTEGER - MAX_READ_LIMIT;

interface BoundedIntegerOptions {
  readonly flag: '--limit' | '--offset';
  readonly minimum: number;
  readonly maximum: number;
  /**
   * Which bounded input this is, for `metadata.condition`.
   *
   * Was a per-call `code: string`, i.e. three distinct codes for one condition. The four
   * run-read inputs now share `VALIDATION.RUN_READ.INPUT_INVALID` and are told apart by this
   * field — bounded, allowlisted, and projectable, which a code string in an options bag is
   * not.
   */
  readonly condition: 'list-limit' | 'step-limit' | 'offset';
}

function parseBoundedInteger(raw: string, options: BoundedIntegerOptions): number {
  const value = DECIMAL_INTEGER.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < options.minimum || value > options.maximum) {
    throw new ValidationError(
      `Invalid ${options.flag} value: '${raw}'. Must be an integer between ${String(options.minimum)} and ${String(options.maximum)}.`,
      {
        code: RUN_READ_INPUT.code,
        definition: RUN_READ_INPUT,
        metadata: { condition: options.condition },
      },
    );
  }
  return value;
}

function parseListLimit(raw: string): number {
  return parseBoundedInteger(raw, {
    flag: '--limit',
    minimum: 1,
    maximum: MAX_READ_LIMIT,
    condition: 'list-limit',
  });
}

function parseStepLimit(raw: string): number {
  return parseBoundedInteger(raw, {
    flag: '--limit',
    minimum: 1,
    maximum: MAX_READ_LIMIT,
    condition: 'step-limit',
  });
}

function parseStepOffset(raw: string): number {
  return parseBoundedInteger(raw, {
    flag: '--offset',
    minimum: 0,
    maximum: MAX_STEP_OFFSET,
    condition: 'offset',
  });
}

function requireRunId(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID.test(value)) {
    throw new ValidationError(
      'Parent Run ID must contain 1-128 letters, numbers, underscores, or hyphens.',
      {
        code: RUN_READ_INPUT.code,
        definition: RUN_READ_INPUT,
        metadata: { condition: 'run-id' },
      },
    );
  }
  return value;
}

function buildRunsListSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/host-subcommand-runs.ts',
      declaration: 'buildRunsListSpec',
    },
    name: 'list',
    description: 'List canonical parent Runs',
    noInit: true,
    commonFlags: ['json'],
    options: [
      {
        flag: '--limit',
        value: '<n>',
        description: 'Maximum parent Runs to return (default 20; 1-500)',
        parse: parseListLimit,
      },
    ],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as { readonly limit?: number };
      return executeRunsList({
        store: ctx.datastore() as DataStore,
        limit: opts.limit ?? DEFAULT_LIST_LIMIT,
      });
    },
  });
}

function buildRunsShowSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/host-subcommand-runs.ts',
      declaration: 'buildRunsShowSpec',
    },
    name: 'show',
    description: 'Show one exact parent Run and its ordered RunSteps',
    noInit: true,
    commonFlags: ['json'],
    args: [{ name: 'run-id', description: 'Exact parent Run ID' }],
    options: [
      {
        flag: '--offset',
        value: '<n>',
        description: 'RunStep offset (default 0; non-negative integer)',
        parse: parseStepOffset,
      },
      {
        flag: '--limit',
        value: '<n>',
        description: 'Maximum RunSteps to return (default 100; 1-500)',
        parse: parseStepLimit,
      },
    ],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as {
        readonly _args?: readonly unknown[];
        readonly offset?: number;
        readonly limit?: number;
      };
      return executeRunsShow({
        store: ctx.datastore() as DataStore,
        runId: requireRunId(opts._args?.[0]),
        offset: opts.offset ?? DEFAULT_STEP_OFFSET,
        limit: opts.limit ?? DEFAULT_STEP_LIMIT,
      });
    },
  });
}

/** Build the two read-only `runs` group leaf specs. */
export function buildRunsGroupLeaves(ctx: CliCommandsContext): readonly HostSpec[] {
  return [buildRunsListSpec(ctx), buildRunsShowSpec(ctx)];
}
