/**
 * register-plugins — Commander wiring for `opensip-tools plugin {list|add|remove|sync}`.
 *
 * Split out of `commands/index.ts` per audit 2026-05-23 M2.
 */

import { mountResultCommand, mountResultCommandWithArg } from './mount-result-command.js';
import { pluginAdd, pluginList, pluginRemove, pluginSync } from './plugin.js';
import { CWD_OPTION_SPEC, JSON_DESC, type CliCommandsContext } from './shared.js';

import type { Command } from 'commander';

export function registerPlugins(program: Command, ctx: CliCommandsContext): void {
  const pluginCmd = program
    .command('plugin')
    .description('Manage project-local plugins (add, list, remove, sync)');

  const listCmd = pluginCmd
    .command('list')
    .description('List installed plugins')
    .option(CWD_OPTION_SPEC, 'Project root', process.cwd())
    .option('--json', JSON_DESC, false);

  mountResultCommand<{ cwd?: string; json: boolean }>(
    listCmd,
    (opts) => pluginList(opts.cwd ?? process.cwd()),
    { ctx, jsonFlag: (opts) => opts.json },
  );

  const addCmd = pluginCmd
    .command('add <package>')
    .description('Install a plugin AND register it in opensip-tools.config.yml')
    .option('--domain <fit|sim>', 'Target domain (default: inferred from package name)')
    .option(CWD_OPTION_SPEC, 'Project root', process.cwd())
    .option('--json', JSON_DESC, false);

  mountResultCommandWithArg<string, { domain?: string; cwd?: string; json: boolean }>(
    addCmd,
    (packageName, opts) => pluginAdd(packageName, opts.cwd ?? process.cwd(), opts.domain),
    { ctx, jsonFlag: (opts) => opts.json },
  );

  const removeCmd = pluginCmd
    .command('remove <package>')
    .description('Uninstall a plugin AND remove it from opensip-tools.config.yml')
    .option('--domain <fit|sim>', 'Target domain (default: inferred from package name)')
    .option(CWD_OPTION_SPEC, 'Project root', process.cwd())
    .option('--json', JSON_DESC, false);

  mountResultCommandWithArg<string, { domain?: string; cwd?: string; json: boolean }>(
    removeCmd,
    (packageName, opts) => pluginRemove(packageName, opts.cwd ?? process.cwd(), opts.domain),
    { ctx, jsonFlag: (opts) => opts.json },
  );

  const syncCmd = pluginCmd
    .command('sync')
    .description('Install every plugin declared in opensip-tools.config.yml (post-clone bootstrap)')
    .option('--domain <fit|sim>', 'Sync only one domain')
    .option(CWD_OPTION_SPEC, 'Project root', process.cwd())
    .option('--json', JSON_DESC, false);

  mountResultCommand<{ domain?: string; cwd?: string; json: boolean }>(
    syncCmd,
    (opts) => pluginSync(opts.cwd ?? process.cwd(), opts.domain),
    { ctx, jsonFlag: (opts) => opts.json },
  );
}
