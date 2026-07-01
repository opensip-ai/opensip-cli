import { describe, expect, it } from 'vitest';

import { MANDATORY_COMMON_FLAGS } from '../cli-flags.js';
import {
  defineAuxExportCommand,
  defineListCommand,
  definePrimaryRunCommand,
  defineRunCommand,
  gateRunFlagSpecs,
  REPORTING_RUN_COMMON_FLAGS,
  sarifRunFlagSpec,
} from '../command-presets.js';

import type { ArgSpec, OptionSpec, ToolCliContext } from '@opensip-cli/core';

const HANDLER = (_opts: Record<string, unknown>, _ctx: ToolCliContext): undefined => undefined;
const OPTIONS: readonly OptionSpec[] = [
  { flag: '--recipe', value: '<name>', description: 'Recipe name' },
];
const ARGS: readonly ArgSpec[] = [
  {
    name: 'paths',
    description: 'Paths to inspect',
    optional: true,
    variadic: true,
  },
];

describe('command presets', () => {
  it('defines primary runtime-dispatched run commands with the full reporting surface', () => {
    const options = [...gateRunFlagSpecs, sarifRunFlagSpec, ...OPTIONS];
    const command = definePrimaryRunCommand({
      description: 'Run audit',
      options,
      args: ARGS,
      handler: HANDLER,
    });

    expect(command).toMatchObject({
      description: 'Run audit',
      commonFlags: REPORTING_RUN_COMMON_FLAGS,
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'runtime-render-dispatch',
      producesVerdict: true,
      options,
      args: ARGS,
    });
    expect(command.commonFlags).not.toBe(REPORTING_RUN_COMMON_FLAGS);
    expect(command.handler).toBe(HANDLER);
  });

  it('shares gate and SARIF option specs for verdict-producing commands', () => {
    expect(gateRunFlagSpecs.map((spec) => spec.flag)).toEqual(['--gate-save', '--gate-compare']);
    expect(sarifRunFlagSpec).toMatchObject({
      flag: '--sarif',
      value: '<path>',
    });
  });

  it('defines primary run commands with the mandatory signal-envelope surface', () => {
    const command = defineRunCommand({
      name: 'graph',
      description: 'Build graph',
      aliases: ['g'],
      options: OPTIONS,
      handler: HANDLER,
    });

    expect(command).toMatchObject({
      name: 'graph',
      description: 'Build graph',
      aliases: ['g'],
      commonFlags: MANDATORY_COMMON_FLAGS,
      scope: 'project',
      output: 'signal-envelope',
      options: OPTIONS,
    });
    expect(command.commonFlags).not.toBe(MANDATORY_COMMON_FLAGS);
    expect(command.handler).toBe(HANDLER);
  });

  it('defines list/catalog commands with the shared command-result surface', () => {
    const command = defineListCommand({
      name: 'graph list',
      description: 'List graph rules',
      handler: HANDLER,
    });

    expect(command).toMatchObject({
      name: 'graph list',
      description: 'List graph rules',
      commonFlags: ['cwd', 'json'],
      scope: 'project',
      output: 'command-result',
    });
    expect(command.aliases).toBeUndefined();
    expect(command.options).toBeUndefined();
    expect(command.handler).toBe(HANDLER);
  });

  it('defines auxiliary export commands as file-export raw streams', () => {
    const command = defineAuxExportCommand({
      name: 'graph export',
      description: 'Export graph data',
      aliases: ['graph catalog-export'],
      options: OPTIONS,
      handler: HANDLER,
    });

    expect(command).toMatchObject({
      name: 'graph export',
      description: 'Export graph data',
      aliases: ['graph catalog-export'],
      commonFlags: ['cwd', 'json'],
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'file-export',
      options: OPTIONS,
    });
    expect(command.handler).toBe(HANDLER);
  });
});
