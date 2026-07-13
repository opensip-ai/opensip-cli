import type { OptionSpec } from '@opensip-cli/core';

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string');
}

function parseRepeatedFile(raw: string, previous: unknown): readonly string[] {
  return [...(isStringArray(previous) ? previous : []), raw];
}

/** Scope-selection options shared by `suite run` and the canonical `audit` command. */
export const SUITE_RUN_OPTIONS: readonly OptionSpec[] = [
  {
    flag: '--config',
    value: '<path>',
    description: 'Path to opensip-cli.config.yml (overrides default root discovery)',
  },
  {
    flag: '--changed',
    description: 'Propagate changed-file selection to compatible suite steps',
    default: false,
  },
  {
    flag: '--since',
    value: '<ref>',
    description: 'Git ref base for compatible changed-file suite steps',
  },
  {
    flag: '--files',
    value: '<path>',
    description: 'Explicit changed file for compatible suite steps (repeatable)',
    arrayDefault: [],
    parse: parseRepeatedFile,
  },
  {
    flag: '--full',
    description: 'Run the whole repo (disable the built-in audit changed-scope default)',
    default: false,
  },
];
