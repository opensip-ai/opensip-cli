/**
 * Command-spec presets — opinionated defaults for the common tool command shapes.
 */

import {
  defineCommand,
  type CommandSpec,
  type CommonFlagKey,
  type RawStreamReason,
  type ToolCliContext,
  type OptionSpec,
} from '@opensip-cli/core';

import { MANDATORY_COMMON_FLAGS } from './cli-flags.js';

type PresetHandler<TOpts> = CommandSpec<TOpts, ToolCliContext>['handler'];

interface CommandPresetInput<TOpts extends Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly options?: readonly OptionSpec[];
  readonly handler: PresetHandler<TOpts>;
}

interface CommandPresetDefaults {
  readonly commonFlags: readonly CommonFlagKey[];
  readonly output: CommandSpec<Record<string, unknown>, ToolCliContext>['output'];
  readonly rawStreamReason?: RawStreamReason;
}

function definePresetCommand<TOpts extends Record<string, unknown>>(
  input: CommandPresetInput<TOpts>,
  defaults: CommandPresetDefaults,
): CommandSpec<TOpts, ToolCliContext> {
  return defineCommand<TOpts, ToolCliContext>({
    name: input.name,
    description: input.description,
    ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
    commonFlags: [...defaults.commonFlags],
    scope: 'project',
    output: defaults.output,
    ...(defaults.rawStreamReason === undefined
      ? {}
      : { rawStreamReason: defaults.rawStreamReason }),
    ...(input.options === undefined ? {} : { options: input.options }),
    handler: input.handler,
  });
}

/** Primary run command: signal-envelope output with the ADR-0021 mandatory flag set. */
export function defineRunCommand<TOpts extends Record<string, unknown>>(
  input: CommandPresetInput<TOpts>,
): CommandSpec<TOpts, ToolCliContext> {
  return definePresetCommand(input, {
    commonFlags: MANDATORY_COMMON_FLAGS,
    output: 'signal-envelope',
  });
}

/** List/catalog command: structured command-result with cwd + json. */
export function defineListCommand<TOpts extends Record<string, unknown>>(
  input: CommandPresetInput<TOpts>,
): CommandSpec<TOpts, ToolCliContext> {
  return definePresetCommand(input, {
    commonFlags: ['cwd', 'json'],
    output: 'command-result',
  });
}

/** Post-write status confirmation (baseline export, symbol index, …). */
export function defineAuxExportCommand<TOpts extends Record<string, unknown>>(
  input: CommandPresetInput<TOpts>,
): CommandSpec<TOpts, ToolCliContext> {
  return definePresetCommand(input, {
    commonFlags: ['cwd', 'json'],
    output: 'raw-stream',
    rawStreamReason: 'file-export',
  });
}
