/**
 * fitnessTool — fitness as a Tool plugin.
 *
 * Owns its full Commander wiring for the `fit`, `dashboard`, `fit-list`,
 * and `fit-recipes` subcommands. The CLI calls register() once at
 * startup and the rest is local: every option-parsing rule, gate-mode
 * dispatch, JSON-vs-Ink rendering decision, and dashboard auto-open
 * lives here, in the package that owns the fitness command surface.
 *
 * The CLI no longer imports `executeFit`, `openDashboard`, etc.
 * directly — it just calls `fitnessTool.register(cli)`. Adding a new
 * subcommand to fitness is a local change; no CLI edit required.
 */


import { EXIT_CODES } from '@opensip-tools/contracts';
import { readPackageVersion } from '@opensip-tools/core';
import { type Command } from 'commander';

import { openDashboard } from './cli/dashboard.js';
import { executeFit } from './cli/fit.js';
import { listChecks } from './cli/list-checks.js';
import { listRecipes } from './cli/list-recipes.js';
import {
  saveBaseline,
  compareToBaseline,
  renderGateCompareOutput,
  GateBaselineMissingError,
  GateBaselineInvalidError,
  DEFAULT_BASELINE_PATH,
} from './gate.js';


import type { CliArgs, FitOptions, ToolOptions } from '@opensip-tools/contracts';
import type { Tool, ToolCliContext, ToolCommandDescriptor } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

// =============================================================================
// COMMAND DESCRIPTORS — used by --help listings and conflict detection.
// =============================================================================

const FIT: ToolCommandDescriptor = {
  name: 'fit',
  description: 'Run fitness checks',
};

const DASHBOARD: ToolCommandDescriptor = {
  name: 'dashboard',
  description: 'Generate the HTML dashboard and open it in your browser',
};

const FIT_LIST: ToolCommandDescriptor = {
  name: 'fit-list',
  description: 'List available fitness checks',
  aliases: ['list-checks'],
};

const FIT_RECIPES: ToolCommandDescriptor = {
  name: 'fit-recipes',
  description: 'List available fitness recipes',
  aliases: ['list-recipes'],
};

// =============================================================================
// REGISTER — wires Commander subcommands onto the CLI's program.
// =============================================================================

function fitOptsToCliArgs(opts: FitOptions & { quiet?: boolean; open?: boolean }): CliArgs {
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
    quiet: opts.quiet === true,
    open: opts.open === true,
    config: opts.config,
    gateSave: opts.gateSave === true,
    gateCompare: opts.gateCompare === true,
    baseline: opts.baseline,
  };
}

function register(cli: ToolCliContext): void {
  // Cast once — the contract intentionally types `program` loosely so
  // tools aren't pinned to a specific Commander major.
  const program = cli.program as Command;

  // -- fit ------------------------------------------------------------------
  program
    .command(FIT.name)
    .description(FIT.description)
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
    .option('--config <path>', 'Path to opensip-tools.config.yml (overrides package.json pointer and default)')
    .option('-q, --quiet', 'Suppress banner / boxes; print only the pass-fail summary', false)
    .option('--open', 'Launch the HTML dashboard in your browser after the run completes', false)
    .option('--debug', 'Enable debug mode for structured log output', false)
    .option('--gate-save', 'Architecture-gate: save current findings as baseline (mutually exclusive with --gate-compare)', false)
    .option('--gate-compare', 'Architecture-gate: compare current findings against baseline; exit 1 on regression', false)
    .option('--baseline <path>', 'Path to baseline file for --gate-save / --gate-compare (default: opensip-tools/.runtime/baseline.sarif)')
    .action(async (opts: FitOptions & { quiet?: boolean; open?: boolean }) => {
      const args = fitOptsToCliArgs(opts);

      // Architecture gate: --gate-save / --gate-compare. Headless,
      // stdout-only, exit code is the gate decision.
      if (args.gateSave === true || args.gateCompare === true) {
        await runGateMode(args, cli);
        return;
      }

      // --list
      if (args.list) {
        const result = await listChecks(args.cwd);
        if (args.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return; }
        await cli.render(result);
        return;
      }

      // --recipes
      if (args.listRecipes) {
        const result = await listRecipes(args.cwd);
        if (args.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return; }
        await cli.render(result);
        return;
      }

      // Main fit execution.
      if (args.json) {
        const fitResult = await executeFit(args, undefined, cli.datastore as DataStore);
        if (fitResult.result.type === 'error') {
          cli.setExitCode(fitResult.result.exitCode);
          process.stdout.write(JSON.stringify({ error: fitResult.result.message }, null, 2) + '\n');
        } else {
          if (fitResult.result.type === 'fit-done' && fitResult.result.shouldFail) {
            cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
          }
          process.stdout.write(JSON.stringify(fitResult.output, null, 2) + '\n');
        }
        return;
      }

      // Visual mode — Ink-rendered live results. The CLI supplies the
      // renderer via cli.renderLive() so this file doesn't depend on
      // the CLI package directly.
      await cli.renderLive('fit', args);

      // --open: launch dashboard after the run when conditions allow.
      await cli.maybeOpenDashboard({
        openRequested: Boolean(opts.open),
        jsonOutput: Boolean(args.json),
        cwd: args.cwd,
      });
    });

  // -- dashboard ------------------------------------------------------------
  program
    .command(DASHBOARD.name)
    .description(DASHBOARD.description)
    .option('--cwd <path>', 'Target directory', process.cwd())
    .option('--json', 'Output structured JSON', false)
    .option('--debug', 'Enable debug mode for structured log output', false)
    .action(async (opts: ToolOptions) => {
      const result = await openDashboard(opts.cwd, cli.datastore as DataStore);
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }
      await cli.render(result);
    });

  // -- fit-list (alias: list-checks) ----------------------------------------
  const fitListCmd = program
    .command(FIT_LIST.name)
    .description(FIT_LIST.description);
  for (const alias of FIT_LIST.aliases ?? []) fitListCmd.alias(alias);
  fitListCmd
    .option('--cwd <path>', 'Target directory', process.cwd())
    .option('--json', 'Output structured JSON', false)
    .action(async (opts: ToolOptions) => {
      const result = await listChecks(opts.cwd);
      if (opts.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return; }
      await cli.render(result);
    });

  // -- fit-recipes (alias: list-recipes) ------------------------------------
  const fitRecipesCmd = program
    .command(FIT_RECIPES.name)
    .description(FIT_RECIPES.description);
  for (const alias of FIT_RECIPES.aliases ?? []) fitRecipesCmd.alias(alias);
  fitRecipesCmd
    .option('--cwd <path>', 'Target directory', process.cwd())
    .option('--json', 'Output structured JSON', false)
    .action(async (opts: ToolOptions) => {
      const result = await listRecipes(opts.cwd);
      if (opts.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return; }
      await cli.render(result);
    });
}

// =============================================================================
// GATE MODE — extracted helper used by `fit --gate-save` / `--gate-compare`.
// =============================================================================

async function runGateMode(args: CliArgs, cli: ToolCliContext): Promise<void> {
  if (args.gateSave === true && args.gateCompare === true) {
    cli.logger.warn({
      evt: 'cli.gate.config_error',
      module: 'cli:gate',
      reason: 'mutually-exclusive flags',
      msg: '--gate-save and --gate-compare specified together',
    });
    cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    process.stderr.write('Error: --gate-save and --gate-compare are mutually exclusive.\n');
    return;
  }
  const baselinePath = args.baseline ?? DEFAULT_BASELINE_PATH;
  const fitResult = await executeFit(args, undefined, cli.datastore as DataStore);
  if (fitResult.result.type !== 'fit-done') {
    cli.logger.warn({
      evt: 'cli.gate.fit_failed',
      module: 'cli:gate',
      mode: args.gateSave === true ? 'save' : 'compare',
      baselinePath,
      reason: fitResult.result.message,
    });
    cli.setExitCode(fitResult.result.exitCode);
    process.stderr.write(`Error: ${fitResult.result.message}\n`);
    return;
  }
  const output = fitResult.output!;
  try {
    if (args.gateSave === true) {
      saveBaseline(output, baselinePath);
      const findingCount = output.checks.reduce((n, c) => n + c.findings.length, 0);
      process.stdout.write(`Baseline saved to ${baselinePath}\n`);
      process.stdout.write(`  ${output.checks.length} check(s), ${findingCount} finding(s)\n`);
      return;
    }
    const result = compareToBaseline(output, baselinePath);
    process.stdout.write(renderGateCompareOutput(result) + '\n');
    cli.setExitCode(result.degraded ? 1 : 0);
    return;
  } catch (error) {
    if (error instanceof GateBaselineMissingError || error instanceof GateBaselineInvalidError) {
      cli.logger.warn({
        evt: 'cli.gate.baseline_error',
        module: 'cli:gate',
        mode: args.gateSave === true ? 'save' : 'compare',
        baselinePath,
        errorType: error.name,
        reason: error.message,
      });
      cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
      process.stderr.write(`Error: ${error.message}\n`);
      return;
    }
    throw error;
  }
}

// =============================================================================
// EXPORT
// =============================================================================

export const fitnessTool: Tool = {
  metadata: {
    id: 'fitness',
    version: readPackageVersion(import.meta.url),
    description: 'Run fitness checks against a codebase',
  },
  commands: [FIT, DASHBOARD, FIT_LIST, FIT_RECIPES],
  register,
  initialize: async (): Promise<void> => {
    // ensureChecksLoaded() is called inside the executeFit / listChecks
    // / listRecipes paths, so a separate initialize() pass is not
    // strictly needed today. Left as a no-op so fitness has somewhere
    // to hang future tool-startup work (eager check-pack discovery,
    // catalog warming, etc.) without requiring a contract change.
  },
};

// Pre-load hook setter — used by the CLI to wire project-plugin
// auto-sync into ensureChecksLoaded's startup path. Re-exported here
// so the CLI's bootstrap doesn't need to deep-import.
export { setPreLoadHook } from './cli/fit.js';
