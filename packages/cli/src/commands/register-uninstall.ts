/**
 * register-uninstall — Commander wiring for `opensip-tools uninstall`.
 *
 * Adopts `mountResultCommand` for the same reason `init` / `sessions` /
 * `configure` / `plugin` do: one render path, one `--json` policy, one
 * exit-code seam. The trailing success / dry-run / cancelled summary
 * is rendered through Ink (`App.tsx`'s `case 'uninstall-done':`)
 * instead of raw stdout writes that bypassed the theme. Audit
 * 2026-05-23 G5 + M2.
 */

import { mountResultCommand } from './mount-result-command.js';
import { type CliCommandsContext } from './shared.js';
import { executeUninstall } from './uninstall.js';

import type { ProjectContext } from '@opensip-tools/core';
import type { Command } from 'commander';

interface UninstallCliOptions {
  yes?: boolean;
  dryRun?: boolean;
  project?: string | boolean;
  purge?: boolean;
  json?: boolean;
  projectContext?: ProjectContext;
}

export function registerUninstall(program: Command, ctx: CliCommandsContext): void {
  const cmd = program
    .command('uninstall')
    .description('Remove user-level config at ~/.opensip-tools/ (cloud API key, defaults). Use --project to remove project-local state instead.')
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .option('--dry-run', 'Print what would be removed; take no action', false)
    .option('--project [path]', 'Remove project-local runtime state at [path] (defaults to cwd). User content + config preserved unless --purge.')
    .option('--purge', 'With --project, also remove user-authored content and opensip-tools.config.yml (DESTRUCTIVE)', false)
    .option('--json', 'Output structured JSON', false);

  mountResultCommand<UninstallCliOptions>(
    cmd,
    async (opts) => {
      // Commander passes `true` when the flag is present without a value,
      // a string when given a value, or undefined when omitted.
      let project: string | true | undefined;
      if (opts.project === true) project = true;
      else if (typeof opts.project === 'string') project = opts.project;
      return executeUninstall({
        yes: opts.yes,
        dryRun: opts.dryRun,
        project,
        purge: opts.purge,
        projectContext: opts.projectContext,
      });
    },
    { ctx, jsonFlag: (opts: UninstallCliOptions) => Boolean(opts.json) },
  );
}
