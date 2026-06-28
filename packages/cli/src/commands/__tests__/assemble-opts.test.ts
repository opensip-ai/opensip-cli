import { ConfigurationError, type OptionSpec } from '@opensip-cli/core';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { assembleOptsFromSpec, optionKey } from '../assemble-opts.js';
import { buildOption } from '../mount-command-spec-wiring.js';

function accumulate(raw: string, previous: unknown): readonly string[] {
  return [...(Array.isArray(previous) ? previous : []), raw];
}

function parseIntOption(raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`bad int: ${raw}`);
  return value;
}

function commanderOpts(
  options: readonly OptionSpec[],
  argv: readonly string[],
): Record<string, unknown> {
  const command = new Command('demo');
  command.exitOverride();
  for (const option of options) command.addOption(buildOption(option, 'demo'));
  command.parse([...argv], { from: 'user' });
  return command.opts();
}

describe('assembleOptsFromSpec', () => {
  it('matches Commander option assembly for defaults, negation, parse reducers, and choices', () => {
    const options: OptionSpec[] = [
      { flag: '--tag', value: '<slug>', description: 'tag', arrayDefault: [], parse: accumulate },
      { flag: '--gate-compare', description: 'compare', default: false },
      { flag: '--no-cache', description: 'cache', negatable: true },
      { flag: '--count', value: '<n>', description: 'count', parse: parseIntOption },
      {
        flag: '--mode',
        value: '<mode>',
        description: 'mode',
        default: 'exact',
        choices: ['exact', 'fast'],
      },
    ];

    const commander = commanderOpts(options, [
      '--tag',
      'security',
      '--tag',
      'perf',
      '--gate-compare',
      '--no-cache',
      '--count',
      '3',
      '--mode',
      'fast',
    ]);
    const direct = assembleOptsFromSpec({
      options,
      suppliedValues: {
        tag: ['security', 'perf'],
        gateCompare: true,
        cache: false,
        count: '3',
        mode: 'fast',
      },
    }).opts;

    expect(direct).toEqual(commander);
  });

  it('enforces choices and required values on the shared suite assembly path', () => {
    expect(() =>
      assembleOptsFromSpec({
        options: [
          { flag: '--mode', value: '<mode>', description: 'mode', choices: ['exact', 'fast'] },
        ],
        suppliedValues: { mode: 'slow' },
      }),
    ).toThrow(ConfigurationError);

    expect(() =>
      assembleOptsFromSpec({
        options: [{ flag: '--tool', value: '<name>', description: 'tool', required: true }],
      }),
    ).toThrow(ConfigurationError);
  });

  it('derives stable camelCase option keys from long flags', () => {
    expect(optionKey({ flag: '-g, --gate-compare', description: 'gate' })).toBe('gateCompare');
    expect(optionKey({ flag: '--no-cache', description: 'cache', negatable: true })).toBe('cache');
  });
});
