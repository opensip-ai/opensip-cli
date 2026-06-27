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
import type { OptionSpec } from '@opensip-cli/core';

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

interface ConfigCommandRawOpts {
  readonly cwd?: string;
  readonly out?: string;
  readonly projectContext?: ProjectContext;
}

interface ConfigCommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly options: readonly OptionSpec[];
  readonly run: (base: ReturnType<typeof configCommandBase>, opts: ConfigCommandRawOpts) => unknown;
}

function configCommandBase(ctx: CliCommandsContext, opts: ConfigCommandRawOpts) {
  const scope = currentScope();
  return {
    tools: requireTools(ctx),
    manifests: ctx.manifests ?? scope?.toolManifests,
    provenance: ctx.provenance ?? scope?.toolProvenance,
    configPath: opts.projectContext?.configPath ?? scope?.projectContext?.configPath,
    cwd: effectiveCwd(opts),
  };
}

function buildConfigCommandSpec(ctx: CliCommandsContext, spec: ConfigCommandDefinition): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: spec.name,
    description: spec.description,
    commonFlags: ['json', 'cwd'],
    options: spec.options,
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as ConfigCommandRawOpts;
      return spec.run(configCommandBase(ctx, opts), opts);
    },
  });
}

function buildConfigValidateSpec(ctx: CliCommandsContext): HostSpec {
  return buildConfigCommandSpec(ctx, {
    name: 'validate',
    description: 'Validate the effective project config against the composed schema',
    options: [
      {
        flag: '--config',
        value: '<path>',
        description: 'Validate the config at this path instead of the discovered project config',
      },
    ],
    run: (base) => executeConfigValidate(base),
  });
}

function buildConfigSchemaSpec(ctx: CliCommandsContext): HostSpec {
  return buildConfigCommandSpec(ctx, {
    name: 'schema',
    description: 'Export the composed project config JSON Schema',
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
    run: (base, opts) => executeConfigSchema({ ...base, outPath: opts.out }),
  });
}
