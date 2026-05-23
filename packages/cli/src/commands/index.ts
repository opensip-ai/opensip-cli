/**
 * commands — registers the CLI-owned subcommands.
 *
 * Cross-tool housekeeping that doesn't belong to any single tool:
 *
 *   - `init`         — scaffold opensip-tools.config.yml + example tree
 *   - `sessions`     — `list` / `purge`
 *   - `configure`    — set up the OpenSIP Cloud API key
 *   - `plugin`       — `list` / `add` / `remove` / `sync`
 *   - `completion`   — print a shell-completion script
 *   - `uninstall`    — remove user-level / project-local state
 *
 * Tool-owned subcommands (`fit`, `sim`, `graph`, …) are mounted
 * separately by walking `defaultToolRegistry` and calling each tool's
 * `register(cli)`.
 */

import {
  EXIT_CODES,
  type CommandResult,
  type InitOptions,
} from '@opensip-tools/contracts';
import { type Command } from 'commander';


import { executeClear } from './clear.js';
import { printCompletionScript } from './completion.js';
import { executeConfigure } from './configure.js';
import { showHistory } from './history.js';
import { executeInit } from './init.js';
import { mountResultCommand, mountResultCommandWithArg } from './mount-result-command.js';
import { pluginAdd, pluginList, pluginRemove, pluginSync } from './plugin.js';
import { executeUninstall } from './uninstall.js';

/** Commander spec for the shared --cwd <path> option (de-duplication for sonarjs). */
const CWD_OPTION_SPEC = '--cwd <path>';
/** Help text for the shared --json flag — every CLI-owned subcommand uses this string verbatim. */
const JSON_DESC = 'Output structured JSON';

export interface CliCommandsContext {
  readonly setExitCode: (code: number) => void;
  readonly render: (result: CommandResult) => Promise<void>;
}

/**
 * Mount the CLI-owned commands onto the supplied Commander program.
 * Pure function — no module-level side effects, no closure over
 * globals — so tests can register commands against a fresh `Command`
 * instance and inspect the resulting subcommand tree.
 */
export function registerCliCommands(program: Command, ctx: CliCommandsContext): void {
  registerInit(program, ctx);
  registerSessions(program, ctx);
  registerConfigure(program, ctx);
  registerPlugins(program, ctx);
  registerCompletion(program, ctx);
  registerUninstall(program, ctx);
}

// =============================================================================
// init
// =============================================================================

function registerInit(program: Command, ctx: CliCommandsContext): void {
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

// =============================================================================
// sessions
// =============================================================================

function registerSessions(program: Command, ctx: CliCommandsContext): void {
  const sessionsCmd = program
    .command('sessions')
    .description('Manage session data');

  const listCmd = sessionsCmd
    .command('list')
    .description('List stored sessions')
    .option('--json', JSON_DESC, false);

  mountResultCommand<{ json: boolean }>(
    listCmd,
    () => showHistory(),
    { ctx, jsonFlag: (opts) => opts.json },
  );

  const purgeCmd = sessionsCmd
    .command('purge')
    .description('Delete session data from opensip-tools/.runtime/sessions/')
    .option('--older-than <days>', 'Only delete sessions older than N days', (v: string) => {
      const n = Number.parseInt(v, 10);
      if (Number.isNaN(n) || n < 0) throw new Error(`Invalid --older-than value: '${v}'. Must be a non-negative integer.`);
      return n;
    })
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .option('--json', JSON_DESC, false);

  mountResultCommand<{ olderThan?: number; yes: boolean; json: boolean }>(
    purgeCmd,
    (opts) => executeClear({ olderThan: opts.olderThan, yes: opts.yes }),
    { ctx, jsonFlag: (opts) => opts.json },
  );
}

// =============================================================================
// configure
// =============================================================================

function registerConfigure(program: Command, ctx: CliCommandsContext): void {
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

// =============================================================================
// plugin
// =============================================================================

function registerPlugins(program: Command, ctx: CliCommandsContext): void {
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

// =============================================================================
// completion
// =============================================================================

function registerCompletion(program: Command, ctx: CliCommandsContext): void {
  program
    .command('completion <shell>')
    .description('Print a shell-completion script (bash | zsh | fish)')
    .action((shell: string) => {
      const normalized = shell.toLowerCase();
      if (normalized !== 'bash' && normalized !== 'zsh' && normalized !== 'fish') {
        process.stderr.write(`Unsupported shell: ${shell}. Expected one of: bash, zsh, fish.\n`);
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return;
      }
      printCompletionScript(normalized);
    });
}

// =============================================================================
// uninstall
// =============================================================================

function registerUninstall(program: Command, ctx: CliCommandsContext): void {
  program
    .command('uninstall')
    .description('Remove user-level config at ~/.opensip-tools/ (cloud API key, defaults). Use --project to remove project-local state instead.')
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .option('--dry-run', 'Print what would be removed; take no action', false)
    .option('--project [path]', 'Remove project-local state (opensip-tools/ and opensip-tools.config.yml) at [path] (defaults to cwd)')
    .action(async (opts: { yes?: boolean; dryRun?: boolean; project?: string | boolean }) => {
      // Commander passes `true` when the flag is present without a value,
      // a string when given a value, or undefined when omitted.
      let project: string | true | undefined;
      if (opts.project === true) project = true;
      else if (typeof opts.project === 'string') project = opts.project;
      const result = await executeUninstall({ yes: opts.yes, dryRun: opts.dryRun, project });
      if (result.cancelled) ctx.setExitCode(EXIT_CODES.SUCCESS);
    });
}
