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
 *
 * Two-key registration invariant
 * ------------------------------
 * Fitness contributes TWO distinct identifiers to the CLI's registries
 * and the mismatch is intentional — do not collapse them:
 *
 *   - `metadata.id = 'fitness'` is the package-wide tool identifier
 *     (conflict-detection key in `defaultToolRegistry`).
 *
 *   - `FIT_LIVE_VIEW_KEY = 'fit'` is the live-view key. Used to call
 *     `cli.registerLiveView('fit', renderer)` and consumed by
 *     `cli.renderLive('fit', args)` in `runLiveMode`. The key matches
 *     the `fit` subcommand name so the dispatcher's `renderLive(key)`
 *     reads naturally next to the command that triggers it.
 *
 * Layer 5 Phase 3 (closes audit 2026-05-23 F3): fitness now ships its
 * own Ink/React renderer (`renderFitLive` in `cli/fit-runner.tsx`)
 * and registers it directly via `cli.registerLiveView`. The prior
 * `cli.builtinLiveViews` self-lookup handshake is gone.
 */


/* eslint-disable sonarjs/deprecation -- intentional adapter usage; tool.ts bridges per-command FitOptions/ToolOptions to executeFit's legacy CliArgs shape via fitOptsToCliArgs / toolOptsToCliArgs */
import {
  EXIT_CODES,
  type CliArgs,
  type CliProgram,
  type FitOptions,
  type ToolOptions,
} from '@opensip-tools/contracts';
/* eslint-enable sonarjs/deprecation */
import { readPackageVersion } from '@opensip-tools/core';

import { exportFitBaseline } from './cli/baseline-export.js';
import { openDashboard } from './cli/dashboard.js';
import { renderFitLive } from './cli/fit-runner.js';
import { executeFit } from './cli/fit.js';
import { listChecks } from './cli/list-checks.js';
import { listRecipes } from './cli/list-recipes.js';
import {
  saveBaseline,
  compareToBaseline,
  renderGateCompareOutput,
  GateBaselineMissingError,
  GateBaselineInvalidError,
} from './gate.js';
import { FitBaselineRepo } from './persistence/baseline-repo.js';

import type {
  Tool,
  ToolCliContext,
  ToolCommandDescriptor,
} from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

// Live-view key fitness contributes to the CLI's renderer registry.
// Owned by this package — the CLI dispatcher does NOT key off this
// literal; each tool decides its own live-view name.
const FIT_LIVE_VIEW_KEY = 'fit';

// Shared option flags + descriptions reused across every fitness
// subcommand. Constants exist to satisfy sonarjs/no-duplicate-string
// and to keep the Commander wiring consistent if the wording changes.
const JSON_FLAG = '--json';
const JSON_DESC = 'Output structured JSON';
const CWD_FLAG = '--cwd <path>';
const CWD_DESC = 'Target directory';

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

const FIT_BASELINE_EXPORT: ToolCommandDescriptor = {
  name: 'fit-baseline-export',
  description: 'Export the fit gate baseline (SARIF) from the datastore to a file',
};

// =============================================================================
// REGISTER — wires Commander subcommands onto the CLI's program.
// =============================================================================

// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
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
  };
}

function register(cli: ToolCliContext): void {
  // Cast once — the contract intentionally types `program` loosely so
  // tools aren't pinned to a specific Commander major. `CliProgram` is
  // contracts' alias for commander's `Command`; using it here keeps
  // tool packages off a direct `commander` import. Audit 2026-05-23 G6.
  const program = cli.program as CliProgram;

  // Contribute fitness's live view to the CLI's renderer registry.
  // Layer 5 Phase 3 (audit 2026-05-23 F3): fitness owns its own
  // Ink/React renderer (`renderFitLive` in `cli/fit-runner.tsx`) and
  // registers it directly. The prior `cli.builtinLiveViews` self-
  // lookup handshake is gone — adding a fourth tool with a live view
  // requires zero CLI edits.
  cli.registerLiveView(FIT_LIVE_VIEW_KEY, async (args) => {
    // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
    await renderFitLive(args as CliArgs, cli.datastore as DataStore | undefined, {
      setExitCode: cli.setExitCode,
    });
  });

  registerFitCommand(program, cli);
  registerDashboardCommand(program, cli);
  registerListCommand(program, cli);
  registerRecipesCommand(program, cli);
  registerBaselineExportCommand(program, cli);
}

// =============================================================================
// SUBCOMMAND REGISTRARS — one per Commander subcommand. Keeps register()
// a thin orchestrator and lets each subcommand's flags + dispatch live
// next to its mode helpers.
// =============================================================================

function registerFitCommand(program: CliProgram, cli: ToolCliContext): void {
  program
    .command(FIT.name)
    .description(FIT.description)
    .option('--recipe <name>', 'Use a named recipe (default, quick-smoke, backend, etc.)')
    .option('--check <slug>', 'Run a single check by slug')
    .option('--tags <tags>', 'Filter checks by tags (comma-separated)')
    .option('--list', 'List available checks', false)
    .option('--recipes', 'List available recipes', false)
    .option(JSON_FLAG, JSON_DESC, false)
    .option('-v, --verbose', 'Show finding details inline + findings summary', false)
    .option('--findings', 'Show all findings grouped by check after the run', false)
    .option('--report-to <url>', 'POST findings to a URL (OpenSIP Cloud or compatible)')
    .option('--api-key <key>', 'API key for --report-to authentication')
    .option('--exclude <slug>', 'Exclude check (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option(CWD_FLAG, CWD_DESC, process.cwd())
    .option('--config <path>', 'Path to opensip-tools.config.yml (overrides package.json pointer and default)')
    .option('-q, --quiet', 'Suppress banner / boxes; print only the pass-fail summary', false)
    .option('--open', 'Launch the HTML dashboard in your browser after the run completes', false)
    .option('--debug', 'Enable debug mode for structured log output', false)
    .option('--gate-save', 'Architecture-gate: save current findings as baseline in the project SQLite store (mutually exclusive with --gate-compare)', false)
    .option('--gate-compare', 'Architecture-gate: compare current findings against the saved baseline; exit 1 on regression', false)
    .action(async (opts: FitOptions & { quiet?: boolean; open?: boolean }) => {
      const args = fitOptsToCliArgs(opts);

      if (args.gateSave === true || args.gateCompare === true) {
        await runGateMode(args, cli);
        return;
      }
      if (args.list) {
        await runListMode(args, cli);
        return;
      }
      if (args.listRecipes) {
        await runRecipesMode(args, cli);
        return;
      }
      if (args.json) {
        await runJsonMode(args, cli);
        return;
      }
      await runLiveMode(args, cli, opts.open === true);
    });
}

function registerDashboardCommand(program: CliProgram, cli: ToolCliContext): void {
  program
    .command(DASHBOARD.name)
    .description(DASHBOARD.description)
    .option(CWD_FLAG, CWD_DESC, process.cwd())
    .option(JSON_FLAG, JSON_DESC, false)
    .option('--debug', 'Enable debug mode for structured log output', false)
    .action(async (opts: ToolOptions) => {
      const result = await openDashboard(opts.cwd, cli.datastore as DataStore);
      if (opts.json) {
        cli.emitJson(result);
        return;
      }
      await cli.render(result);
    });
}

function registerListCommand(program: CliProgram, cli: ToolCliContext): void {
  const fitListCmd = program
    .command(FIT_LIST.name)
    .description(FIT_LIST.description);
  for (const alias of FIT_LIST.aliases ?? []) fitListCmd.alias(alias);
  fitListCmd
    .option(CWD_FLAG, CWD_DESC, process.cwd())
    .option(JSON_FLAG, JSON_DESC, false)
    .action(async (opts: ToolOptions) => {
      const result = await listChecks(opts.cwd);
      if (opts.json) { cli.emitJson(result); return; }
      await cli.render(result);
    });
}

function registerRecipesCommand(program: CliProgram, cli: ToolCliContext): void {
  const fitRecipesCmd = program
    .command(FIT_RECIPES.name)
    .description(FIT_RECIPES.description);
  for (const alias of FIT_RECIPES.aliases ?? []) fitRecipesCmd.alias(alias);
  fitRecipesCmd
    .option(CWD_FLAG, CWD_DESC, process.cwd())
    .option(JSON_FLAG, JSON_DESC, false)
    .action(async (opts: ToolOptions) => {
      const result = await listRecipes(opts.cwd);
      if (opts.json) { cli.emitJson(result); return; }
      await cli.render(result);
    });
}

function registerBaselineExportCommand(program: CliProgram, cli: ToolCliContext): void {
  program
    .command(FIT_BASELINE_EXPORT.name)
    .description(FIT_BASELINE_EXPORT.description)
    .requiredOption('--out <path>', 'Output file path for the SARIF baseline')
    .option(CWD_FLAG, CWD_DESC, process.cwd())
    .option(JSON_FLAG, JSON_DESC, false)
    .action((opts: ToolOptions & { out: string }) => {
      const datastore = cli.datastore as DataStore;
      const result = exportFitBaseline(datastore, opts.out);
      if (result.type === 'error') {
        cli.setExitCode(result.exitCode);
        if (opts.json) {
          cli.emitJson({ error: result.message });
          return;
        }
        process.stderr.write(`Error: ${result.message}\n`);
        return;
      }
      if (opts.json) {
        cli.emitJson(result);
        return;
      }
      process.stdout.write(
        `Exported fit baseline to ${result.outPath} (${String(result.bytesWritten)} bytes)\n`,
      );
    });
}

// =============================================================================
// MODE HELPERS — one per dispatch branch in the `fit` action. Each is
// callable independently for testing; the action picks one based on the
// flag combination.
// =============================================================================

// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
async function runListMode(args: CliArgs, cli: ToolCliContext): Promise<void> {
  const result = await listChecks(args.cwd);
  if (args.json) { cli.emitJson(result); return; }
  await cli.render(result);
}

// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
async function runRecipesMode(args: CliArgs, cli: ToolCliContext): Promise<void> {
  const result = await listRecipes(args.cwd);
  if (args.json) { cli.emitJson(result); return; }
  await cli.render(result);
}

/**
 * `--json` mode: run executeFit, write output (or error) to stdout, and
 * propagate the configured fail threshold via the CLI's exit-code hook.
 *
 * Threads `datastore` so a `--json` run lands in the SQLite session
 * history alongside live-mode and gate-mode runs. No `onProgress`: JSON
 * output is one-shot, no progress UI.
 */
// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
async function runJsonMode(args: CliArgs, cli: ToolCliContext): Promise<void> {
  const fitResult = await executeFit(args, { datastore: cli.datastore as DataStore | undefined });
  if (fitResult.result.type === 'error') {
    cli.setExitCode(fitResult.result.exitCode);
    cli.emitJson({ error: fitResult.result.message });
    return;
  }
  if (fitResult.result.type === 'fit-done' && fitResult.result.shouldFail) {
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
  }
  cli.emitJson(fitResult.output);
  // Warnings collected during the run go to stderr so JSON consumers still
  // see them without contaminating the structured stdout payload.
  emitWarningsToStderr(fitResult.result);
}

/**
 * Emit any non-fatal warnings collected during the run to stderr. Safe to
 * call from non-Ink paths (JSON, gate modes) because Ink is not managing
 * the screen there. The live renderer surfaces these through Ink in the
 * summary block instead.
 */
function emitWarningsToStderr(result: { warnings?: readonly string[] }): void {
  if (!result.warnings || result.warnings.length === 0) return;
  for (const msg of result.warnings) {
    process.stderr.write(`opensip-tools: ${msg}\n`);
  }
}

/**
 * Visual mode — Ink-rendered live results. The CLI supplies the
 * renderer via `cli.renderLive()` so this file doesn't depend on the
 * CLI package directly. After the run, optionally launches the HTML
 * dashboard.
 */
async function runLiveMode(
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
  args: CliArgs,
  cli: ToolCliContext,
  openRequested: boolean,
): Promise<void> {
  await cli.renderLive(FIT_LIVE_VIEW_KEY, args);
  await cli.maybeOpenDashboard({
    openRequested,
    jsonOutput: Boolean(args.json),
  });
}

// =============================================================================
// GATE MODE — extracted helper used by `fit --gate-save` / `--gate-compare`.
// =============================================================================

// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
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
  const datastore = cli.datastore as DataStore;
  const repo = new FitBaselineRepo(datastore);
  // Thread the bootstrap-supplied datastore through executeFit so its
  // post-call SessionRepo.save uses the same handle the gate baseline
  // is written against — gate-save / gate-compare runs land in the
  // session history alongside live-mode runs.
  const fitResult = await executeFit(args, { datastore });
  if (fitResult.result.type !== 'fit-done') {
    cli.logger.warn({
      evt: 'cli.gate.fit_failed',
      module: 'cli:gate',
      mode: args.gateSave === true ? 'save' : 'compare',
      reason: fitResult.result.message,
    });
    cli.setExitCode(fitResult.result.exitCode);
    process.stderr.write(`Error: ${fitResult.result.message}\n`);
    return;
  }
  const output = fitResult.output!;
  // Surface non-fatal warnings before the gate output so the user sees them
  // alongside the run summary. Safe here because gate mode is non-Ink.
  emitWarningsToStderr(fitResult.result);
  try {
    if (args.gateSave === true) {
      saveBaseline(output, repo);
      const findingCount = output.checks.reduce((n, c) => n + c.findings.length, 0);
      process.stdout.write(`Baseline saved (project SQLite store)\n`);
      process.stdout.write(`  ${output.checks.length} check(s), ${findingCount} finding(s)\n`);
      return;
    }
    const result = compareToBaseline(output, repo);
    process.stdout.write(renderGateCompareOutput(result) + '\n');
    cli.setExitCode(result.degraded ? 1 : 0);
    return;
  } catch (error) {
    if (error instanceof GateBaselineMissingError || error instanceof GateBaselineInvalidError) {
      cli.logger.warn({
        evt: 'cli.gate.baseline_error',
        module: 'cli:gate',
        mode: args.gateSave === true ? 'save' : 'compare',
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
  commands: [FIT, DASHBOARD, FIT_LIST, FIT_RECIPES, FIT_BASELINE_EXPORT],
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
