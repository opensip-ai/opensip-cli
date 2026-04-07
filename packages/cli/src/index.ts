#!/usr/bin/env node

/**
 * OpenSIP Tools CLI — codebase analysis toolkit
 *
 * Usage:
 *   opensip-tools fit [options]     Run fitness checks
 *   opensip-tools fit --list        List available checks
 *   opensip-tools fit --recipes     List available recipes
 *   opensip-tools sim [options]     Run simulation scenarios
 */

import { Command } from 'commander';

import {
  setSilent, setDebugMode,
  generatePrefixedId, setRunId, initLogFile, logger,
} from '@opensip-tools/core';

import { EXIT_CODES, getErrorSuggestion } from './exit-codes.js';

export { EXIT_CODES, getErrorSuggestion } from './exit-codes.js';
export type { CliOutput, CheckOutput, FindingOutput, TableRow, SummaryOptions, CommandResult, CliArgs, FitOptions, InitOptions, ToolOptions } from './types.js';
export { buildSarifLog, reportToCloud } from './sarif.js';
export { resolveApiKey } from './commands/configure.js';

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// Command imports
import { executeFit } from './commands/fit.js';
import { listChecks } from './commands/list-checks.js';
import { listRecipes } from './commands/list-recipes.js';
import { openDashboard } from './commands/dashboard.js';
import { executeInit } from './commands/init.js';
import { executeSim } from './commands/sim.js';
import { pluginList, pluginInstall, pluginRemove } from './commands/plugin.js';
import { executeConfigure, resolveApiKey } from './commands/configure.js';
import { reportToCloud } from './sarif.js';

import type { CliArgs, FitOptions, InitOptions, ToolOptions } from './types.js';

// =============================================================================
// CONFIG FILE (.opensip-tools.yml)
// =============================================================================

interface ToolsConfig {
  recipe?: string;
  exclude?: string[];
  verbose?: boolean;
  json?: boolean;
  reportTo?: string;
  apiKey?: string;
  fileTypes?: string[];
  ignore?: string[];
}

const CONFIG_FILENAMES = ['.opensip-tools.yml', '.opensip-tools.yaml', 'opensip-tools.yml'];

function loadConfig(cwd: string): ToolsConfig {
  for (const filename of CONFIG_FILENAMES) {
    const filePath = join(cwd, filename);
    if (existsSync(filePath)) {
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf-8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({
          evt: 'cli.config.read_error',
          module: 'cli',
          file: filePath,
          error: message,
          msg: `Failed to read ${filename}: ${message}. Falling back to defaults.`,
        });
        return {};
      }

      let parsed: ToolsConfig | null;
      try {
        parsed = parseYaml(raw) as ToolsConfig | null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({
          evt: 'cli.config.yaml_error',
          module: 'cli',
          file: filePath,
          error: message,
          msg: `${filename} contains invalid YAML: ${message}. Falling back to defaults.`,
        });
        return {};
      }

      const config = parsed ?? {};

      // Validate expected field types
      const warnings: string[] = [];
      if (config.recipe !== undefined && typeof config.recipe !== 'string') {
        warnings.push('recipe: expected string');
        delete config.recipe;
      }
      if (config.verbose !== undefined && typeof config.verbose !== 'boolean') {
        warnings.push('verbose: expected boolean');
        delete config.verbose;
      }
      if (config.json !== undefined && typeof config.json !== 'boolean') {
        warnings.push('json: expected boolean');
        delete config.json;
      }
      if (config.exclude !== undefined && !Array.isArray(config.exclude)) {
        warnings.push('exclude: expected array');
        delete config.exclude;
      }
      if (config.reportTo !== undefined && typeof config.reportTo !== 'string') {
        warnings.push('reportTo: expected string');
        delete config.reportTo;
      }
      if (config.apiKey !== undefined && typeof config.apiKey !== 'string') {
        warnings.push('apiKey: expected string');
        delete config.apiKey;
      }

      if (warnings.length > 0) {
        logger.warn({
          evt: 'cli.config.validation_warning',
          module: 'cli',
          file: filePath,
          issues: warnings,
          msg: `${filename} has invalid fields (ignored): ${warnings.join(', ')}`,
        });
      }

      return config;
    }
  }
  return {};
}

// =============================================================================
// HELPERS
// =============================================================================

/** Convert FitOptions (Commander) into the CliArgs shape expected by commands. */
function fitOptsToCliArgs(opts: FitOptions): CliArgs {
  return {
    command: 'fit',
    json: opts.json,
    check: opts.check,
    recipe: opts.recipe,
    cwd: opts.cwd,
    help: false,
    list: opts.list,
    listRecipes: opts.recipes,
    verbose: opts.verbose,
    reportTo: opts.reportTo,
    apiKey: opts.apiKey,
    exclude: opts.exclude,
    findings: opts.findings,
    tags: opts.tags,
  };
}

function initOptsToCliArgs(opts: InitOptions): CliArgs {
  return {
    command: 'init',
    json: opts.json,
    cwd: opts.cwd,
    help: false,
    list: false,
    listRecipes: false,
    verbose: false,
    exclude: [],
    findings: false,
  };
}

function toolOptsToCliArgs(command: string, opts: ToolOptions): CliArgs {
  return {
    command,
    json: opts.json,
    cwd: opts.cwd,
    help: false,
    list: false,
    listRecipes: false,
    verbose: false,
    exclude: [],
    findings: false,
  };
}

/** Merge config-file defaults into Commander options (config is lower priority). */
function mergeConfigDefaults(opts: Record<string, unknown>, config: ToolsConfig): void {
  // Only apply config defaults when the CLI didn't explicitly set a value
  if (config.recipe && opts.recipe === undefined) opts.recipe = config.recipe;
  if (config.verbose && opts.verbose === false) opts.verbose = config.verbose;
  if (config.json && opts.json === false) opts.json = config.json;
  if (config.reportTo && opts.reportTo === undefined) opts.reportTo = config.reportTo;
  if (config.exclude && Array.isArray(opts.exclude) && (opts.exclude as string[]).length === 0) {
    (opts.exclude as string[]).push(...config.exclude);
  }

  // API key resolution: --api-key flag > project config > OPENSIP_API_KEY env > ~/.opensip-tools/config.yml
  if (opts.apiKey === undefined) {
    if (config.apiKey) {
      opts.apiKey = config.apiKey;
    } else {
      opts.apiKey = resolveApiKey();
    }
  }
}

// =============================================================================
// INK RENDER HELPER
// =============================================================================

async function renderResult(result: import('./types.js').CommandResult): Promise<void> {
  const { renderApp } = await import('./ui/render.js');
  await renderApp(result);
}

// =============================================================================
// COMMANDER PROGRAM
// =============================================================================

const program = new Command('opensip-tools')
  .description('Codebase analysis toolkit')
  .version('0.1.0');

// ---------------------------------------------------------------------------
// preAction hook — runs before every command
// ---------------------------------------------------------------------------

program.hook('preAction', (_thisCommand, actionCommand) => {
  const runId = generatePrefixedId('run');
  setRunId(runId);
  initLogFile();

  // Silence framework logger — CLI output goes through Ink
  setSilent(true);

  const opts = actionCommand.opts();
  if (opts.debug) {
    setDebugMode(true);
  }

  // Load config from --cwd and merge defaults
  const cwd = (opts.cwd as string) ?? process.cwd();
  const config = loadConfig(cwd);
  mergeConfigDefaults(opts, config);

  logger.info({ evt: 'cli.start', runId, command: actionCommand.name(), cwd });
});

// ---------------------------------------------------------------------------
// fit subcommand
// ---------------------------------------------------------------------------

program
  .command('fit')
  .description('Run fitness checks')
  .option('--recipe <name>', 'Use a named recipe (default, quick-smoke, backend, etc.)')
  .option('--check <slug>', 'Run a single check by slug')
  .option('--tags <tags>', 'Filter checks by tags (comma-separated)')
  .option('--list', 'List available checks', false)
  .option('--recipes', 'List available recipes', false)
  .option('--json', 'Output structured JSON', false)
  .option('-v, --verbose', 'Show finding details inline + findings summary', false)
  .option('--findings', 'Show all findings grouped by check after the run', false)
  .option('--report-to <url>', 'POST findings to a URL (OpenSIP Cloud or compatible)')
  .option('--api-key <key>', 'API key for --report-to authentication')
  .option('--exclude <slug>', 'Exclude check (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
  .option('--cwd <path>', 'Target directory', process.cwd())
  .option('--debug', 'Enable debug mode for structured log output', false)
  .action(async (opts: FitOptions) => {
    const args = fitOptsToCliArgs(opts);

    // --list
    if (args.list) {
      const result = await listChecks();
      if (args.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return; }
      await renderResult(result);
      return;
    }

    // --recipes
    if (args.listRecipes) {
      const result = listRecipes();
      if (args.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return; }
      await renderResult(result);
      return;
    }

    // Main fit execution
    if (args.json) {
      // JSON mode: run headless, output JSON
      const fitResult = await executeFit(args);
      if (fitResult.result.type === 'error') {
        process.exitCode = fitResult.result.exitCode;
        process.stdout.write(JSON.stringify({ error: fitResult.result.message }, null, 2) + '\n');
      } else {
        if (fitResult.result.type === 'fit-done' && fitResult.result.shouldFail) {
          process.exitCode = 1;
        }
        process.stdout.write(JSON.stringify(fitResult.output, null, 2) + '\n');
      }
      return;
    }

    // Visual mode: render with real-time spinner → results
    const { renderFitView } = await import('./ui/render.js');
    await renderFitView(args);
  });

// ---------------------------------------------------------------------------
// init subcommand
// ---------------------------------------------------------------------------

program
  .command('init')
  .description('Generate opensip-tools.config.yml config for your project')
  .option('--cwd <path>', 'Target directory', process.cwd())
  .option('--json', 'Output structured JSON', false)
  .option('--debug', 'Enable debug mode for structured log output', false)
  .action(async (opts: InitOptions) => {
    const args = initOptsToCliArgs(opts);
    const result = executeInit(args);
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }
    await renderResult(result);
  });

// ---------------------------------------------------------------------------
// sessions subcommand (with list and purge sub-subcommands)
// ---------------------------------------------------------------------------

const sessionsCmd = program
  .command('sessions')
  .description('Manage session data');

sessionsCmd
  .command('list')
  .description('List stored sessions')
  .action(async () => {
    const { showHistory } = await import('./commands/history.js');
    const result = showHistory();
    await renderResult(result);
  });

sessionsCmd
  .command('purge')
  .description('Delete session data from ~/.opensip-tools/sessions/')
  .option('--older-than <days>', 'Only delete sessions older than N days', (v: string) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 0) throw new Error(`Invalid --older-than value: '${v}'. Must be a non-negative integer.`);
    return n;
  })
  .option('-y, --yes', 'Skip confirmation prompt', false)
  .action(async (opts: { olderThan?: number; yes: boolean }) => {
    const { executeClear } = await import('./commands/clear.js');
    await executeClear({ olderThan: opts.olderThan, yes: opts.yes });
  });

// ---------------------------------------------------------------------------
// dashboard subcommand
// ---------------------------------------------------------------------------

program
  .command('dashboard')
  .description('Generate HTML report and open in browser')
  .option('--cwd <path>', 'Target directory', process.cwd())
  .option('--json', 'Output structured JSON', false)
  .option('--debug', 'Enable debug mode for structured log output', false)
  .action(async (opts: ToolOptions) => {
    const result = await openDashboard();
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }
    await renderResult(result);
  });

// ---------------------------------------------------------------------------
// configure subcommand
// ---------------------------------------------------------------------------

program
  .command('configure')
  .description('Set up OpenSIP Cloud API key')
  .option('--debug', 'Enable debug mode for structured log output', false)
  .action(async () => {
    await executeConfigure();
  });

// ---------------------------------------------------------------------------
// sim subcommand
// ---------------------------------------------------------------------------

program
  .command('sim')
  .description('Run simulation scenarios [experimental]')
  .option('--cwd <path>', 'Target directory', process.cwd())
  .option('--json', 'Output structured JSON', false)
  .option('--debug', 'Enable debug mode for structured log output', false)
  .action(async (opts: ToolOptions) => {
    const args = toolOptsToCliArgs('sim', opts);
    const result = executeSim(args);
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }
    await renderResult(result);
  });

// ---------------------------------------------------------------------------
// plugin subcommand
// ---------------------------------------------------------------------------

const pluginCmd = program
  .command('plugin')
  .description('Manage installed plugins (install, list, remove)');

pluginCmd
  .command('list')
  .description('List installed plugins')
  .option('--domain <fit|sim>', 'Target domain')
  .action(async () => {
    const result = await pluginList();
    await renderResult(result);
  });

pluginCmd
  .command('install <package>')
  .description('Install a plugin package')
  .option('--domain <fit|sim>', 'Target domain')
  .action(async (packageName: string, opts: { domain?: string }) => {
    const result = await pluginInstall(packageName, opts.domain);
    await renderResult(result);
  });

pluginCmd
  .command('remove <package>')
  .description('Remove a plugin package')
  .option('--domain <fit|sim>', 'Target domain')
  .action(async (packageName: string, opts: { domain?: string }) => {
    const result = await pluginRemove(packageName, opts.domain);
    await renderResult(result);
  });

// =============================================================================
// TOP-LEVEL ERROR HANDLER
// =============================================================================

program.parseAsync().catch(async (err) => {
  const suggestion = getErrorSuggestion(err);

  if (suggestion) {
    await renderResult({
      type: 'error',
      message: suggestion.message,
      suggestion: suggestion.action,
      exitCode: suggestion.exitCode,
    });
    process.exitCode = suggestion.exitCode;
  } else {
    const message = err instanceof Error ? err.message : String(err);
    await renderResult({
      type: 'error',
      message,
      exitCode: EXIT_CODES.RUNTIME_ERROR,
    });
    process.exitCode = EXIT_CODES.RUNTIME_ERROR;
  }
});
