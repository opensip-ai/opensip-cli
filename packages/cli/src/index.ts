#!/usr/bin/env node

/**
 * OpenSIP Tools CLI — generic tool dispatcher.
 *
 * Build the Commander tree by walking `defaultToolRegistry` and asking
 * each registered Tool to mount its own subcommands via Tool.register().
 * The CLI owns only the cross-tool surface: argv setup, top-level help,
 * preAction logging hooks, the welcome screen, the rendering layer
 * (Ink), session/plugin housekeeping commands, error-suggestion mapping,
 * and the dashboard auto-open helper.
 *
 * fitness and simulation are first-party tools — registered statically
 * at startup. Third-party tools are discovered via
 * `discoverToolPackages()` in core (any npm package whose package.json
 * declares `opensipTools.kind === 'tool'`).
 *
 * Adding a new tool to the CLI now requires zero changes here: write a
 * Tool implementation, install the package, the CLI picks it up.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';


import {
  EXIT_CODES,
  configurePersistencePaths,
  getErrorSuggestion,
  type CommandResult,
  type InitOptions,
} from '@opensip-tools/contracts';
import {
  setSilent,
  setDebugMode,
  generatePrefixedId,
  setRunId,
  initLogFile,
  logger,
  defaultLanguageRegistry,
  defaultToolRegistry,
  discoverToolPackages,
  resolveProjectPaths,
  type LiveViewRenderer,
  type Tool,
  type ToolCliContext,
} from '@opensip-tools/core';
import { loadSignalersConfig, fitnessTool, openDashboard } from '@opensip-tools/fitness';
import { graphTool } from '@opensip-tools/graph';
import { cppAdapter } from '@opensip-tools/lang-cpp';
import { goAdapter } from '@opensip-tools/lang-go';
import { javaAdapter } from '@opensip-tools/lang-java';
import { pythonAdapter } from '@opensip-tools/lang-python';
import { rustAdapter } from '@opensip-tools/lang-rust';
import { typescriptAdapter } from '@opensip-tools/lang-typescript';
import { simulationTool } from '@opensip-tools/simulation';
import { Command } from 'commander';

// Register the bundled language adapters at module load time, BEFORE the
// fitness tool's initialize() runs. An empty adapter registry would let
// scope-empty checks scan everything as plain text and produce zero
// findings — a silent-success failure mode this layer is designed to
// avoid. Side-effect registrations are imported here (not in
// fitness/engine) so fitness doesn't take a hard dep on every lang
// pack: the layered architecture has CLI as the one component that
// wires concrete adapters into the kernel registries.
defaultLanguageRegistry.register(typescriptAdapter);
defaultLanguageRegistry.register(rustAdapter);
defaultLanguageRegistry.register(pythonAdapter);
defaultLanguageRegistry.register(javaAdapter);
defaultLanguageRegistry.register(goAdapter);
defaultLanguageRegistry.register(cppAdapter);

import { createLiveViewRegistry } from './cli-context.js';
import { printCompletionScript } from './commands/completion.js';
import { executeConfigure, resolveApiKey } from './commands/configure.js';
import { executeInit } from './commands/init.js';
import { pluginAdd, pluginList, pluginRemove, pluginSync } from './commands/plugin.js';
import { executeUninstall } from './commands/uninstall.js';
import { decideOpen, launchBrowser } from './open-dashboard.js';
import { maybeNotify } from './update-notifier.js';
import { printWelcome } from './welcome.js';

import type { SignalersConfig } from '@opensip-tools/fitness';

// =============================================================================
// PUBLIC RE-EXPORTS — the CLI's own programmatic API surface.
// =============================================================================

export { EXIT_CODES, getErrorSuggestion } from '@opensip-tools/contracts';
export { buildWelcome, printWelcome } from './welcome.js';
export { buildCompletionScript, printCompletionScript } from './commands/completion.js';
export { executeUninstall } from './commands/uninstall.js';
export { decideOpen, launchBrowser } from './open-dashboard.js';
export { maybeNotify } from './update-notifier.js';
export type {
  CliOutput,
  CheckOutput,
  FindingOutput,
  TableRow,
  SummaryOptions,
  CommandResult,
  CliArgs,
  FitOptions,
  InitOptions,
  ToolOptions,
} from '@opensip-tools/contracts';
export { resolveApiKey } from './commands/configure.js';

// =============================================================================
// VERSION
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_VERSION = ((): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// =============================================================================
// CLI DEFAULTS (read from `cli:` block in opensip-tools.config.yml)
// =============================================================================

type CliDefaults = SignalersConfig['cli'];

function loadCliDefaults(cwd: string, explicitConfigPath?: string): CliDefaults {
  try {
    return loadSignalersConfig(cwd, explicitConfigPath).cli;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug({
      evt: 'cli.config.unavailable',
      module: 'cli',
      cwd,
      error: message,
    });
    return {};
  }
}

function mergeConfigDefaults(opts: Record<string, unknown>, config: CliDefaults): void {
  if (config.recipe && opts.recipe === undefined) opts.recipe = config.recipe;
  if (config.verbose && opts.verbose === false) opts.verbose = config.verbose;
  if (config.json && opts.json === false) opts.json = config.json;
  if (config.reportTo && opts.reportTo === undefined) opts.reportTo = config.reportTo;
  if (config.exclude && Array.isArray(opts.exclude) && (opts.exclude as string[]).length === 0) {
    (opts.exclude as string[]).push(...config.exclude);
  }
  if (opts.apiKey === undefined) {
    opts.apiKey = config.apiKey ?? resolveApiKey();
  }
}

// =============================================================================
// INK RENDER HELPERS — the CLI owns the React/Ink layer; tools call back
// into these via ToolCliContext.
// =============================================================================

async function renderResult(result: CommandResult): Promise<void> {
  const { renderApp } = await import('./ui/render.js');
  await renderApp(result);
}

// Live-view registry — populated by each tool's register(cli) call via
// ToolCliContext.registerLiveView(). renderLive(key, args) looks up the
// registered renderer; an unregistered key throws
// UnknownLiveViewError rather than silently falling back to a static
// render (the latter masked bugs where a tool mistyped its view key).
// Implementation factored into `cli-context.ts` so it can be unit-tested
// in isolation from the Commander bootstrap.
const liveViews = createLiveViewRegistry(logger);

// Built-in renderer adapters for first-party tools. The Ink/React UI
// components live in the CLI package (layered architecture forbids
// fitness/graph from depending on CLI), so the CLI hands each
// first-party tool its renderer through `ctx.builtinLiveViews`. Each
// tool's `register(cli)` looks up its own id and calls
// `cli.registerLiveView(viewKey, cli.builtinLiveViews.get(toolId))`
// — the live-view key (`'fit'`, `'graph'`) is owned by the tool, not
// the CLI dispatcher.
const fitLiveRenderer: LiveViewRenderer = async (args) => {
  const { renderFitView } = await import('./ui/render.js');
  await renderFitView(args as Parameters<typeof renderFitView>[0]);
};

const graphLiveRenderer: LiveViewRenderer = async (args) => {
  const { renderGraphView } = await import('./ui/render.js');
  await renderGraphView(args as Parameters<typeof renderGraphView>[0]);
};

const builtinLiveViews: ReadonlyMap<string, LiveViewRenderer> = new Map([
  [fitnessTool.metadata.id, fitLiveRenderer],
  [graphTool.metadata.id, graphLiveRenderer],
]);

// =============================================================================
// DASHBOARD AUTO-OPEN — used by tools that produce a session worth
// rendering in the HTML dashboard.
// =============================================================================

async function maybeOpenDashboard(opts: {
  openRequested: boolean;
  jsonOutput: boolean;
  cwd: string;
}): Promise<void> {
  const decision = decideOpen({
    openRequested: opts.openRequested,
    jsonOutput: opts.jsonOutput,
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  });
  if (!decision.shouldOpen) return;
  const dash = await openDashboard(opts.cwd);
  if (dash.type === 'dashboard' && dash.path) {
    await launchBrowser(dash.path);
  }
}

// =============================================================================
// COMMANDER PROGRAM
// =============================================================================

const program = new Command('opensip-tools')
  .description('Codebase analysis toolkit — pluggable tools for fitness, simulation, and more')
  .version(PKG_VERSION);

program.hook('preAction', (_thisCommand, actionCommand) => {
  const runId = generatePrefixedId('run');
  setRunId(runId);
  setSilent(true);

  const opts = actionCommand.opts();
  if (opts.debug) setDebugMode(true);

  const cwd = (opts.cwd as string) ?? process.cwd();
  const config = loadCliDefaults(cwd, opts.config as string | undefined);
  mergeConfigDefaults(opts, config);

  // Configure project-local persistence and logging paths from the
  // path resolver. Logger writes JSONL to
  // <cwd>/opensip-tools/.runtime/logs/<YYYY-MM-DD>.jsonl; sessions and
  // dashboard reports land alongside it. Both functions are
  // idempotent + best-effort, so a non-init'd project (no
  // opensip-tools/ dir yet) still gets a logger that fails silently
  // and a session store that creates the dir on first write.
  const projectPaths = resolveProjectPaths(cwd);
  initLogFile(projectPaths.logsDir);
  configurePersistencePaths(projectPaths);

  logger.info({ evt: 'cli.start', module: 'cli:bootstrap', runId, command: actionCommand.name(), cwd });
});

// =============================================================================
// TOOL REGISTRATION
// =============================================================================

function buildToolCliContext(): ToolCliContext {
  let exitCode: number | undefined;
  // Capture the exit code in the closure so process.exitCode is set
  // exactly once, after all tools have run. Commander invokes actions
  // synchronously w.r.t. parseAsync; the assignment below lands before
  // Node exits.
  const ctx: ToolCliContext = {
    program,
    render: (result) => renderResult(result as CommandResult),
    registerLiveView: liveViews.register,
    renderLive: liveViews.render,
    builtinLiveViews,
    maybeOpenDashboard,
    logger,
    setExitCode: (code) => {
      exitCode = code;
      process.exitCode = code;
    },
  };
  // Reference exitCode so the linter doesn't drop it; useful for
  // future debug logging that wants to know the final code.
  void exitCode;
  return ctx;
}

const cliContext = buildToolCliContext();

// First-party tools — declared as direct deps of @opensip-tools/cli.
defaultToolRegistry.register(fitnessTool);
defaultToolRegistry.register(simulationTool);
defaultToolRegistry.register(graphTool);

// Third-party tools — npm packages whose package.json declares
// opensipTools.kind === 'tool'. Discovered relative to the CLI's own
// install location so users get the bundled tools by default; a
// project-local config can override later.
//
// The bundled-id skip below is **defense in depth**: as of Layer 1
// Phase 1 the registry itself enforces first-writer-wins on duplicate
// ids and logs a structured `tool.registry.duplicate` warning. Keeping
// the explicit guard avoids a noisy warning when a third-party package
// happens to ship under a built-in id.
async function loadDiscoveredTools(): Promise<void> {
  const cliInstallDir = dirname(__dirname); // packages/cli/
  const discovered = discoverToolPackages({ projectDir: cliInstallDir });
  for (const pkg of discovered) {
    try {
      const mod = (await import(pkg.name)) as { tool?: Tool };
      if (
        mod.tool &&
        mod.tool.metadata.id !== fitnessTool.metadata.id &&
        mod.tool.metadata.id !== simulationTool.metadata.id &&
        mod.tool.metadata.id !== graphTool.metadata.id
      ) {
        defaultToolRegistry.registerThirdParty(mod.tool, { sourcePackage: pkg.name });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`opensip-tools: failed to load tool ${pkg.name}: ${msg}\n`);
      logger.warn({
        evt: 'cli.tool.load_failed',
        module: 'cli:bootstrap',
        name: pkg.name,
        error: msg,
      });
    }
  }
}

// Wire each registered tool's commands onto the program. We do this
// synchronously after registry population so all `--help` listings see
// every tool's commands before parseAsync runs.
function registerAllTools(): void {
  for (const tool of defaultToolRegistry.list()) {
    try {
      tool.register(cliContext);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`opensip-tools: tool ${tool.metadata.id} failed to register: ${msg}\n`);
      logger.warn({
        evt: 'cli.tool.register_failed',
        module: 'cli:bootstrap',
        toolId: tool.metadata.id,
        error: msg,
      });
    }
  }
}

// =============================================================================
// CLI-OWNED COMMANDS — cross-tool housekeeping that doesn't belong to
// any single tool.
// =============================================================================

/** Commander spec for the shared --cwd <path> option (de-duplication for sonarjs). */
const CWD_OPTION_SPEC = '--cwd <path>';

function registerCliCommands(): void {
  // -- init --------------------------------------------------------------
  program
    .command('init')
    .description('Scaffold opensip-tools.config.yml + example checks/scenarios for your project')
    .option(CWD_OPTION_SPEC, 'Target directory', process.cwd())
    .option('--language <list>', 'Comma-separated language list (typescript|rust|python|go|java|cpp). Default: detect from filesystem markers.')
    .option('--force', 'Overwrite an existing config + example files', false)
    .option('--json', 'Output structured JSON', false)
    .option('--debug', 'Enable debug mode for structured log output', false)
    .action(async (opts: InitOptions) => {
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

      // Detection ambiguity — exit 2 with the prompt message.
      if (result.ambiguousLanguageError) {
        cliContext.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        if (args.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        await renderResult(result);
        return;
      }

      if (args.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }
      await renderResult(result);
    });

  // -- sessions ----------------------------------------------------------
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
    .description('Delete session data from opensip-tools/.runtime/sessions/')
    .option('--older-than <days>', 'Only delete sessions older than N days', (v: string) => {
      const n = Number.parseInt(v, 10);
      if (Number.isNaN(n) || n < 0) throw new Error(`Invalid --older-than value: '${v}'. Must be a non-negative integer.`);
      return n;
    })
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .action(async (opts: { olderThan?: number; yes: boolean }) => {
      const { executeClear } = await import('./commands/clear.js');
      await executeClear({ olderThan: opts.olderThan, yes: opts.yes });
    });

  // -- configure ---------------------------------------------------------
  program
    .command('configure')
    .description('Set up OpenSIP Cloud API key')
    .option('--debug', 'Enable debug mode for structured log output', false)
    .action(async () => {
      await executeConfigure();
    });

  // -- plugin ------------------------------------------------------------
  const pluginCmd = program
    .command('plugin')
    .description('Manage project-local plugins (add, list, remove, sync)');

  pluginCmd
    .command('list')
    .description('List installed plugins')
    .option(CWD_OPTION_SPEC, 'Project root', process.cwd())
    .action(async (opts: { cwd?: string }) => {
      const result = await pluginList(opts.cwd ?? process.cwd());
      await renderResult(result);
    });

  pluginCmd
    .command('add <package>')
    .description('Install a plugin AND register it in opensip-tools.config.yml')
    .option('--domain <fit|sim>', 'Target domain (default: inferred from package name)')
    .option(CWD_OPTION_SPEC, 'Project root', process.cwd())
    .action(async (packageName: string, opts: { domain?: string; cwd?: string }) => {
      const result = await pluginAdd(packageName, opts.cwd ?? process.cwd(), opts.domain);
      await renderResult(result);
    });

  pluginCmd
    .command('remove <package>')
    .description('Uninstall a plugin AND remove it from opensip-tools.config.yml')
    .option('--domain <fit|sim>', 'Target domain (default: inferred from package name)')
    .option(CWD_OPTION_SPEC, 'Project root', process.cwd())
    .action(async (packageName: string, opts: { domain?: string; cwd?: string }) => {
      const result = await pluginRemove(packageName, opts.cwd ?? process.cwd(), opts.domain);
      await renderResult(result);
    });

  pluginCmd
    .command('sync')
    .description('Install every plugin declared in opensip-tools.config.yml (post-clone bootstrap)')
    .option('--domain <fit|sim>', 'Sync only one domain')
    .option(CWD_OPTION_SPEC, 'Project root', process.cwd())
    .action(async (opts: { domain?: string; cwd?: string }) => {
      const result = await pluginSync(opts.cwd ?? process.cwd(), opts.domain);
      await renderResult(result);
    });

  // -- completion --------------------------------------------------------
  program
    .command('completion <shell>')
    .description('Print a shell-completion script (bash | zsh | fish)')
    .action((shell: string) => {
      const normalized = shell.toLowerCase();
      if (normalized !== 'bash' && normalized !== 'zsh' && normalized !== 'fish') {
        process.stderr.write(`Unsupported shell: ${shell}. Expected one of: bash, zsh, fish.\n`);
        process.exitCode = EXIT_CODES.CONFIGURATION_ERROR;
        return;
      }
      printCompletionScript(normalized);
    });

  // -- uninstall ---------------------------------------------------------
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
      if (result.cancelled) process.exitCode = EXIT_CODES.SUCCESS;
    });
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  await loadDiscoveredTools();
  registerAllTools();
  registerCliCommands();

  // Bare `opensip-tools` with no subcommand → welcome screen.
  if (process.argv.length <= 2) {
    printWelcome({ version: program.version() ?? 'dev' });
    process.exit(0);
  }

  // Fire an update check (once/day, non-blocking, TTY-gated, opt-out).
  maybeNotify({ name: '@opensip-tools/cli', version: program.version() ?? '0.0.0' });

  await program.parseAsync().catch(async (error) => {
    const suggestion = getErrorSuggestion(error);
    if (suggestion) {
      await renderResult({
        type: 'error',
        message: suggestion.message,
        suggestion: suggestion.action,
        exitCode: suggestion.exitCode,
      });
      process.exitCode = suggestion.exitCode;
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await renderResult({
        type: 'error',
        message,
        exitCode: EXIT_CODES.RUNTIME_ERROR,
      });
      process.exitCode = EXIT_CODES.RUNTIME_ERROR;
    }
  });
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`opensip-tools: fatal error: ${message}\n`);
  process.exit(EXIT_CODES.RUNTIME_ERROR);
}
