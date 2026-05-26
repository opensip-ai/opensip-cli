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
import type { ProjectContext } from '@opensip-tools/core';
import type { Command } from 'commander';

interface InitOptionsPlus extends InitOptions {
  projectContext?: ProjectContext;
}

export function registerInit(program: Command, ctx: CliCommandsContext): void {
  const cmd = program
    .command('init')
    .description('Scaffold opensip-tools.config.yml + example checks/scenarios for your project')
    .option(CWD_OPTION_SPEC, 'Target directory', process.cwd())
    .option('--language <list>', 'Comma-separated language list (typescript|rust|python|go|java|cpp). Default: detect from filesystem markers.')
    .option('--keep', 'Re-scaffold example files. Preserve any custom files in opensip-tools/.', false)
    .option('--remove', 'Delete opensip-tools/ entirely, then scaffold fresh.', false)
    .option('--json', JSON_DESC, false)
    .option('--debug', 'Enable debug mode for structured log output', false);

  mountResultCommand<InitOptionsPlus>(
    cmd,
    (opts) => {
      // Detect whether --cwd was passed explicitly. Commander's
      // getOptionValueSource('cwd') returns 'cli' for an explicit flag,
      // 'default' otherwise. The escape hatch for `init --cwd .` from
      // a subdir of an existing project hangs off this.
      const cwdExplicit = cmd.getOptionValueSource('cwd') === 'cli';
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
        keep: opts.keep,
        remove: opts.remove,
        projectContext: opts.projectContext,
        cwdExplicit,
      };
      const result = executeInit(args);
      // Exit 2 for any non-success path that the user can act on:
      // ambiguous-language detection, partial-state refusal, mutex flag
      // error, inside-existing-project refusal.
      if (
        result.ambiguousLanguageError ||
        result.partialStateError ||
        result.insideExistingProject
      ) {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
      }
      return result;
    },
    { ctx, jsonFlag: (opts: InitOptionsPlus) => opts.json },
  );
}
