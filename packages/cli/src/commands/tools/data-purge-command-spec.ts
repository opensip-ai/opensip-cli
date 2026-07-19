/**
 * Declarative `tools data-purge` leaf.
 *
 * Kept separate from the tools-group composition module so the latter stays a
 * compact inventory of the independently implemented tool-management leaves.
 */

import { EXIT_CODES, type CommandResult } from '@opensip-cli/contracts';
import { currentScope } from '@opensip-cli/core';

import { defineHostCommand as defineCommand } from '../host-runtime-access.js';

import { assertToolDataPurgeId, deriveToolDataPurgeIdForms, toolsDataPurge } from './data-purge.js';

import type { HostRuntimeCommandSpec } from '../host-runtime-access.js';
import type { CliCommandsContext } from '../shared.js';
import type { DataStore } from '@opensip-cli/datastore';

type HostSpec = HostRuntimeCommandSpec<unknown, CliCommandsContext>;

interface DataPurgeOpts {
  readonly _args: string[];
}

/** Build the project-scoped destructive-data leaf for the tools group. */
export function createToolsDataPurgeSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/tools/index.ts',
      declaration: 'buildToolsDataPurgeSpec',
    },
    name: 'data-purge',
    description:
      'Delete one tool’s project SQLite rows (sessions, baselines, state) — never tables',
    commonFlags: ['json'],
    args: [{ name: 'tool-id', description: 'The tool id whose rows to delete' }],
    scope: 'project',
    output: 'command-result',
    handler: (rawOpts) => {
      const opts = rawOpts as DataPurgeOpts;
      const rawId = opts._args[0] ?? '';
      let toolId: string;
      try {
        // Reject empty/whitespace/reserved-prefix before opening repositories.
        toolId = assertToolDataPurgeId(rawId);
      } catch (error) {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return Promise.resolve({
          type: 'tools-data-purge',
          toolId: rawId,
          sessions: 0,
          baselineEntries: 0,
          baselineMeta: false,
          stateRows: 0,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          target: rawId,
        } as CommandResult);
      }
      const datastore = ctx.datastore() as DataStore | undefined;
      if (datastore === undefined) {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return Promise.resolve({
          type: 'tools-data-purge',
          toolId,
          sessions: 0,
          baselineEntries: 0,
          baselineMeta: false,
          stateRows: 0,
          success: false,
          error: 'tools data-purge requires the project datastore (run inside a project)',
          target: toolId,
        } as CommandResult);
      }
      const scope = currentScope();
      return Promise.resolve(
        toolsDataPurge(
          toolId,
          datastore,
          deriveToolDataPurgeIdForms(toolId, scope?.tools),
          scope?.logger,
        ),
      );
    },
  });
}
