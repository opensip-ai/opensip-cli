/**
 * Command-spec presets — opinionated defaults for the common tool command shapes.
 */

import {
  defineCommand,
  definePrimaryCommand,
  type CommandSpec,
  type CommonFlagKey,
  type ArgSpec,
  type RawStreamReason,
  type ToolCliContext,
  type OptionSpec,
  type PrimaryCommandSpecDraft,
} from '@opensip-cli/core';

import { MANDATORY_COMMON_FLAGS } from './cli-flags.js';

type PresetHandler<TOpts> = CommandSpec<TOpts, ToolCliContext>['handler'];

interface CommandPresetInput<TOpts> {
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly options?: readonly OptionSpec[];
  readonly args?: readonly ArgSpec[];
  readonly handler: PresetHandler<TOpts>;
}

interface PrimaryRunCommandPresetInput<TOpts> {
  readonly description: string;
  readonly options?: readonly OptionSpec[];
  readonly args?: readonly ArgSpec[];
  readonly handler: PresetHandler<TOpts>;
}

interface CommandPresetDefaults {
  readonly commonFlags: readonly CommonFlagKey[];
  readonly output: CommandSpec<Record<string, unknown>, ToolCliContext>['output'];
  readonly rawStreamReason?: RawStreamReason;
  readonly producesVerdict?: boolean;
}

/** Common flags for report-producing primary run commands. */
export const REPORTING_RUN_COMMON_FLAGS: readonly CommonFlagKey[] = [
  ...MANDATORY_COMMON_FLAGS,
  'open',
] as const;

/** Shared gate trigger flags for tools that participate in the baseline plane. */
export const gateRunFlagSpecs: readonly OptionSpec[] = [
  {
    flag: '--gate-save',
    description:
      'Architecture-gate: save current findings as baseline in the project SQLite store (mutually exclusive with --gate-compare)',
    default: false,
  },
  {
    flag: '--gate-compare',
    description:
      'Architecture-gate: compare current findings against the saved baseline; exit 1 on regression',
    default: false,
  },
] as const;

/** Shared SARIF side-output trigger for verdict-producing run commands. */
export const sarifRunFlagSpec: OptionSpec = {
  flag: '--sarif',
  value: '<path>',
  description:
    'Also write this run findings as SARIF 2.1.0. Composes with --gate-save; written even when the gate fails.',
} as const;

function definePresetCommand<TOpts>(
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
    ...(defaults.producesVerdict === undefined
      ? {}
      : { producesVerdict: defaults.producesVerdict }),
    ...(input.options === undefined ? {} : { options: input.options }),
    ...(input.args === undefined ? {} : { args: input.args }),
    handler: input.handler,
  });
}

/** Primary first-party run command with runtime dispatch and the full report surface. */
export function definePrimaryRunCommand<TOpts>(
  input: PrimaryRunCommandPresetInput<TOpts>,
): PrimaryCommandSpecDraft<TOpts, ToolCliContext> {
  return definePrimaryCommand<TOpts, ToolCliContext>({
    description: input.description,
    commonFlags: [...REPORTING_RUN_COMMON_FLAGS],
    ...(input.options === undefined ? {} : { options: input.options }),
    ...(input.args === undefined ? {} : { args: input.args }),
    scope: 'project',
    output: 'raw-stream',
    rawStreamReason: 'runtime-render-dispatch',
    producesVerdict: true,
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
