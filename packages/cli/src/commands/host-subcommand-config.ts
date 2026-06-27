/**
 * `config` subcommand group leaf specs (`validate`, `schema`).
 */

import { currentScope, type ProjectContext } from '@opensip-cli/core';

import { executeConfigSchema, executeConfigValidate } from './config.js';
import {
  COMMAND_RESULT,
  defineCommand,
  effectiveCwd,
  PROJECT_SCOPE,
  type HostSpec,
} from './host-subcommand-shared.js';

import type { CliCommandsContext } from './shared.js';

/** @throws {Error} When the tool registry is missing from context and scope. */
function requireTools(ctx: CliCommandsContext) {
  const tools = ctx.tools ?? currentScope()?.tools;
  if (tools === undefined) {
    throw new Error('config commands require a tool registry on the command context.');
  }
  return tools;
}

export function buildConfigGroupLeaves(ctx: CliCommandsContext): readonly HostSpec[] {
  return [buildConfigValidateSpec(ctx), buildConfigSchemaSpec(ctx)];
}

function buildConfigValidateSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'validate',
    description: 'Validate the effective project config against the composed schema',
    commonFlags: ['json', 'cwd'],
    options: [
      {
        flag: '--config',
        value: '<path>',
        description: 'Validate the config at this path instead of the discovered project config',
      },
    ],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as { cwd?: string; projectContext?: ProjectContext };
      const scope = currentScope();
      return executeConfigValidate({
        tools: requireTools(ctx),
        manifests: ctx.manifests ?? scope?.toolManifests,
        provenance: ctx.provenance ?? scope?.toolProvenance,
        configPath: opts.projectContext?.configPath ?? scope?.projectContext?.configPath,
        cwd: effectiveCwd(opts),
      });
    },
  });
}

function buildConfigSchemaSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'schema',
    description: 'Export the composed project config JSON Schema',
    commonFlags: ['json', 'cwd'],
    options: [
      {
        flag: '--config',
        value: '<path>',
        description:
          'Resolve the project from the config at this path instead of the discovered one',
      },
      {
        flag: '--out',
        value: '<path>',
        description: 'Write the JSON Schema to a file instead of stdout',
      },
    ],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as {
        cwd?: string;
        out?: string;
        projectContext?: ProjectContext;
      };
      const scope = currentScope();
      return executeConfigSchema({
        tools: requireTools(ctx),
        manifests: ctx.manifests ?? scope?.toolManifests,
        provenance: ctx.provenance ?? scope?.toolProvenance,
        configPath: opts.projectContext?.configPath ?? scope?.projectContext?.configPath,
        cwd: effectiveCwd(opts),
        outPath: opts.out,
      });
    },
  });
}
