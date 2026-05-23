/**
 * register-configure — Commander wiring for `opensip-tools configure`.
 *
 * Split out of `commands/index.ts` per audit 2026-05-23 M2.
 */

import { executeConfigure } from './configure.js';
import { mountResultCommand } from './mount-result-command.js';
import { JSON_DESC, type CliCommandsContext } from './shared.js';

import type { Command } from 'commander';

export function registerConfigure(program: Command, ctx: CliCommandsContext): void {
  const cmd = program
    .command('configure')
    .description('Set up OpenSIP Cloud API key')
    .option('--json', JSON_DESC, false)
    .option('--debug', 'Enable debug mode for structured log output', false);

  mountResultCommand<{ json: boolean }>(
    cmd,
    () => executeConfigure(),
    { ctx, jsonFlag: (opts) => opts.json },
  );
}
