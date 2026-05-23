/**
 * register-init — Commander wiring for `opensip-tools init`.
 *
 * Split out of `commands/index.ts` so each cross-tool housekeeping
 * command owns its option declarations + dispatch in one file. Mirrors
 * how `bootstrap/` already shapes itself. Audit 2026-05-23 M2.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';

import { executeInit } from './init.js';
import { mountResultCommand } from './mount-result-command.js';
import { CWD_OPTION_SPEC, JSON_DESC, type CliCommandsContext } from './shared.js';

import type { InitOptions } from '@opensip-tools/contracts';
import type { Command } from 'commander';

export function registerInit(program: Command, ctx: CliCommandsContext): void {
  const cmd = program
    .command('init')
    .description('Scaffold opensip-tools.config.yml + example checks/scenarios for your project')
    .option(CWD_OPTION_SPEC, 'Target directory', process.cwd())
    .option('--language <list>', 'Comma-separated language list (typescript|rust|python|go|java|cpp). Default: detect from filesystem markers.')
    .option('--force', 'Overwrite an existing config + example files', false)
    .option('--json', JSON_DESC, false)
    .option('--debug', 'Enable debug mode for structured log output', false);

  mountResultCommand<InitOptions>(
    cmd,
    (opts) => {
      const args = {
        command: 'init',
        json: opts.json,
        cwd: opts.cwd,
        help: false,
        list: false,
        listRecipes: false,
        verbose: false,
        exclude: [],
        findings: false,
        language: opts.language,
        force: opts.force,
      };
      const result = executeInit(args);
      if (result.ambiguousLanguageError) {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
      }
      return result;
    },
    { ctx, jsonFlag: (opts: InitOptions) => opts.json },
  );
}
