/**
 * register-plugins — Commander wiring for `opensip-tools plugin {list|add|remove|sync}`.
 *
 * Split out of `commands/index.ts` per audit 2026-05-23 M2.
 */

import { mountResultCommand, mountResultCommandWithArg } from './mount-result-command.js';
import { pluginAdd, pluginList, pluginRemove, pluginSync } from './plugin.js';
import { CWD_OPTION_SPEC, JSON_DESC, type CliCommandsContext } from './shared.js';

import type { ProjectContext } from '@opensip-tools/core';
import type { Command } from 'commander';

interface CwdOpts {
  readonly cwd?: string;
  readonly projectContext?: ProjectContext;
}

/** Prefer the discovered project root; fall back to literal cwd; finally process.cwd(). */
function effectiveCwd(opts: CwdOpts): string {
  return opts.projectContext?.projectRoot ?? opts.cwd ?? process.cwd();
}

export function registerPlugins(program: Command, ctx: CliCommandsContext): void {
  const pluginCmd = program
    .command('plugin')
    .description('Manage project-local plugins (add, list, remove, sync)');

  const listCmd = pluginCmd
    .command('list')
    .description('List installed plugins')
    .option(CWD_OPTION_SPEC, 'Project root', process.cwd())
    .option('--json', JSON_DESC, false);

  mountResultCommand<{ cwd?: string; projectContext?: ProjectContext; json: boolean }>(
    listCmd,
    (opts) => pluginList(effectiveCwd(opts), ctx.pluginLayouts),
    { ctx, jsonFlag: (opts) => opts.json },
  );

  const addCmd = pluginCmd
    .command('add <package>')
    .description('Install a plugin (fit/sim pack → project config; tool → user-global by default)')
    .option('--domain <fit|sim|tool>', 'Target domain (default: inferred; tool plugins auto-detected by marker)')
    .option('--project', 'For a tool plugin, install project-local (.runtime/) instead of user-global', false)
    .option(CWD_OPTION_SPEC, 'Project root', process.cwd())
    .option('--json', JSON_DESC, false);

  mountResultCommandWithArg<string, { domain?: string; project?: boolean; cwd?: string; projectContext?: ProjectContext; json: boolean }>(
    addCmd,
    (packageName, opts) =>
      pluginAdd(packageName, effectiveCwd(opts), opts.domain, ctx.pluginLayouts, { project: opts.project }),
    { ctx, jsonFlag: (opts) => opts.json },
  );

  const removeCmd = pluginCmd
    .command('remove <package>')
    .description('Uninstall a plugin (and remove from opensip-tools.config.yml for fit/sim packs)')
    .option('--domain <fit|sim|tool>', 'Target domain (default: inferred from package name)')
    .option('--project', 'For a tool plugin, target the project-local install instead of user-global', false)
    .option(CWD_OPTION_SPEC, 'Project root', process.cwd())
    .option('--json', JSON_DESC, false);

  mountResultCommandWithArg<string, { domain?: string; project?: boolean; cwd?: string; projectContext?: ProjectContext; json: boolean }>(
    removeCmd,
    (packageName, opts) =>
      pluginRemove(packageName, effectiveCwd(opts), opts.domain, ctx.pluginLayouts, { project: opts.project }),
    { ctx, jsonFlag: (opts) => opts.json },
  );

  const syncCmd = pluginCmd
    .command('sync')
    .description('Install every plugin declared in opensip-tools.config.yml (post-clone bootstrap)')
    .option('--domain <fit|sim>', 'Sync only one domain')
    .option(CWD_OPTION_SPEC, 'Project root', process.cwd())
    .option('--json', JSON_DESC, false);

  mountResultCommand<{ domain?: string; cwd?: string; projectContext?: ProjectContext; json: boolean }>(
    syncCmd,
    (opts) => pluginSync(effectiveCwd(opts), opts.domain, ctx.pluginLayouts),
    { ctx, jsonFlag: (opts) => opts.json },
  );
}
