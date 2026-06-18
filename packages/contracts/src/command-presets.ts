/**
 * Command-spec presets — opinionated defaults for the common tool command shapes.
 */

import {
  defineCommand,
  type CommandSpec,
  type ToolCliContext,
  type OptionSpec,
} from '@opensip-cli/core';

import { MANDATORY_COMMON_FLAGS } from './cli-flags.js';

type PresetHandler<TOpts> = CommandSpec<TOpts, ToolCliContext>['handler'];

/** Primary run command: signal-envelope output with the ADR-0021 mandatory flag set. */
export function defineRunCommand<TOpts extends Record<string, unknown>>(input: {
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly options?: readonly OptionSpec[];
  readonly handler: PresetHandler<TOpts>;
}): CommandSpec<TOpts, ToolCliContext> {
  return defineCommand<TOpts, ToolCliContext>({
    name: input.name,
    description: input.description,
    ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
    commonFlags: [...MANDATORY_COMMON_FLAGS],
    scope: 'project',
    output: 'signal-envelope',
    ...(input.options === undefined ? {} : { options: input.options }),
    handler: input.handler,
  });
}

/** List/catalog command: structured command-result with cwd + json. */
export function defineListCommand<TOpts extends Record<string, unknown>>(input: {
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly options?: readonly OptionSpec[];
  readonly handler: PresetHandler<TOpts>;
}): CommandSpec<TOpts, ToolCliContext> {
  return defineCommand<TOpts, ToolCliContext>({
    name: input.name,
    description: input.description,
    ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
    commonFlags: ['cwd', 'json'],
    scope: 'project',
    output: 'command-result',
    ...(input.options === undefined ? {} : { options: input.options }),
    handler: input.handler,
  });
}

/** Post-write status confirmation (baseline export, symbol index, …). */
export function defineAuxExportCommand<TOpts extends Record<string, unknown>>(input: {
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly options?: readonly OptionSpec[];
  readonly handler: PresetHandler<TOpts>;
}): CommandSpec<TOpts, ToolCliContext> {
  return defineCommand<TOpts, ToolCliContext>({
    name: input.name,
    description: input.description,
    ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
    commonFlags: ['cwd', 'json'],
    scope: 'project',
    output: 'raw-stream',
    rawStreamReason: 'file-export',
    ...(input.options === undefined ? {} : { options: input.options }),
    handler: input.handler,
  });
}
