// @fitness-ignore-file no-direct-stdout-in-tool-engine -- auxiliary subcommand status line: `fit-baseline-export` writes the SARIF baseline to a file and prints a one-line "Exported fit baseline to <path>" confirmation (the --json path uses cli.emitJson). This is not the signal-envelope run output (ADR-0011), which routes through the composition root.
/**
 * fitnessTool — fitness as a Tool plugin.
 *
 * Owns its full Commander wiring for the `fit`, `fit-list`,
 * `fit-recipes`, and `fit-baseline-export` subcommands. The CLI calls
 * register() once at startup and the rest is local: every option-parsing
 * rule, gate-mode dispatch, JSON-vs-Ink rendering decision, and the
 * post-run dashboard auto-open (`fit --open`) lives here, in the package
 * that owns the fitness command surface. (The standalone `dashboard`
 * subcommand is owned by the CLI, which composes it from every tool's
 * contributed data — see packages/cli/src/commands/register-dashboard.ts.)
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
 *     (conflict-detection key in the CLI-managed tool registry).
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
 *
 * Module layout
 * -------------
 * - This file owns Commander wiring + the tool descriptor.
 * - `cli/fit-modes.ts` owns the dispatch branches (gate/list/recipes/
 *   json/live) and their shared option-bridge helper. Extracted to
 *   keep this module focused on registration and stay under the
 *   file-length-limit.
 */


import {
  applyCommonFlags,
  type CliProgram,
  type FitOptions,
  type ToolOptions,
} from '@opensip-tools/contracts';
import { readPackageVersion } from '@opensip-tools/core';

import { exportFitBaseline } from './cli/baseline-export.js';
import { collectFitnessDashboardData } from './cli/dashboard.js';
import { fitnessConfigDeclaration } from './config/fitness-config-schema.js';
import {
  runGateMode,
  runJsonMode,
  runListMode,
  runLiveMode,
  runRecipesMode,
} from './cli/fit-modes.js';
import { renderFitLive } from './cli/fit-runner.js';
import { listChecks } from './cli/list-checks.js';
import { listRecipes } from './cli/list-recipes.js';
import {
  createCheckRegistry,
  createFitnessLoadState,
  createRecipeRegistry,
} from './framework/scope-registry.js';
import { FIT_PLUGIN_LAYOUT } from './plugins/loader.js';
// Side-effect import: ensures the RunScope.fitness augmentation is loaded so
// `scope.fitness` is the correctly-typed slot here.
import './scope-augmentation.js';

import type {
  ScopeContribution,
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

// =============================================================================
// COMMAND DESCRIPTORS — used by --help listings and conflict detection.
// =============================================================================

const FIT: ToolCommandDescriptor = {
  name: 'fit',
  description: 'Run fitness checks',
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
    const fitArgs = args as FitOptions;
    const envelope = await renderFitLive(fitArgs, cli.scope.datastore() as DataStore | undefined, {
      setExitCode: cli.setExitCode,
    });
    // Effectful egress lives at the composition root (ADR-0011 / ADR-0008):
    // best-effort cloud sync + `--report-to` (which owns exit 4). Delivered
    // ONCE, after the interactive Ink view exits. A content failure
    // (critical/high signals) dominates a `--report-to` upload failure so a
    // real failure is never masked by exit 4.
    if (envelope !== undefined) {
      await cli.deliverSignals(envelope, {
        cwd: fitArgs.cwd,
        reportTo: fitArgs.reportTo,
        apiKey: fitArgs.apiKey,
        runFailed: !envelope.verdict.passed,
      });
    }
  });

  registerFitCommand(program, cli);
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
  const fitCmd = program
    .command(FIT.name)
    .description(FIT.description)
    .option('--recipe <name>', 'Use a named recipe (default, quick-smoke, backend, etc.)')
    .option('--check <slug>', 'Run a single check by slug')
    .option('--tags <tags>', 'Filter checks by tags (comma-separated)')
    .option('--list', 'List available checks', false)
    .option('--recipes', 'List available recipes', false)
    .option('--findings', '(deprecated: use --verbose) Show all findings grouped by check after the run', false)
    .option('--exclude <slug>', 'Exclude check (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--config <path>', 'Path to opensip-tools.config.yml (overrides package.json pointer and default)')
    .option('--gate-save', 'Architecture-gate: save current findings as baseline in the project SQLite store (mutually exclusive with --gate-compare)', false)
    .option('--gate-compare', 'Architecture-gate: compare current findings against the saved baseline; exit 1 on regression', false);
  // Common cross-tool flags from the single registry (ADR-0021): --cwd, --json,
  // --quiet, --verbose, --debug, --report-to, --api-key, --open. fit-specific
  // flags stay declared above.
  applyCommonFlags(
    fitCmd,
    ['cwd', 'json', 'quiet', 'verbose', 'debug', 'reportTo', 'apiKey', 'open'],
    { cwd: process.cwd() },
  );
  fitCmd
    .action(async (opts: FitOptions) => {
      // --findings is the deprecated alias of --verbose (ADR-0021, ADR-0012
      // one-release window): fold it into verbose so the single verbose path
      // drives the detail body. The deprecation note surfaces through the
      // run's warnings channel (not a raw stderr write — ADR-0011).
      if (opts.findings === true) opts.verbose = true;
      if (opts.gateSave === true || opts.gateCompare === true) {
        await runGateMode(opts, cli);
        return;
      }
      if (opts.list) {
        await runListMode(opts, cli);
        return;
      }
      if (opts.recipes) {
        await runRecipesMode(opts, cli);
        return;
      }
      if (opts.json) {
        await runJsonMode(opts, cli);
        return;
      }
      await runLiveMode(opts, cli, FIT_LIVE_VIEW_KEY, opts.open === true);
    });
}

function registerListCommand(program: CliProgram, cli: ToolCliContext): void {
  const fitListCmd = program
    .command(FIT_LIST.name)
    .description(FIT_LIST.description);
  for (const alias of FIT_LIST.aliases ?? []) fitListCmd.alias(alias);
  applyCommonFlags(fitListCmd, ['cwd', 'json'], { cwd: process.cwd() });
  fitListCmd
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
  applyCommonFlags(fitRecipesCmd, ['cwd', 'json'], { cwd: process.cwd() });
  fitRecipesCmd
    .action(async (opts: ToolOptions) => {
      const result = await listRecipes(opts.cwd);
      if (opts.json) { cli.emitJson(result); return; }
      await cli.render(result);
    });
}

function registerBaselineExportCommand(program: CliProgram, cli: ToolCliContext): void {
  const fitBaselineCmd = program
    .command(FIT_BASELINE_EXPORT.name)
    .description(FIT_BASELINE_EXPORT.description)
    .requiredOption('--out <path>', 'Output file path for the SARIF baseline');
  applyCommonFlags(fitBaselineCmd, ['cwd', 'json'], { cwd: process.cwd() });
  fitBaselineCmd
    .action(async (opts: ToolOptions & { out: string }) => {
      const datastore = cli.scope.datastore() as DataStore;
      const result = await exportFitBaseline(datastore, opts.out, cli);
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
      process.stdout.write(`Exported fit baseline to ${result.outPath}\n`);
    });
}

/**
 * Per-run subscope contribution (D7). Called by the CLI's pre-action-hook
 * after constructing the scope and before entering it; the kernel installs
 * the returned `fitness` slot. Fresh check + recipe registries (and an empty
 * `ensureChecksLoaded` lifecycle slot) per run so concurrent scopes carry
 * independent fitness state.
 */
function contributeScope(): ScopeContribution {
  return {
    fitness: {
      checks: createCheckRegistry(),
      recipes: createRecipeRegistry(),
      load: createFitnessLoadState(),
    },
  };
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
  commands: [FIT, FIT_LIST, FIT_RECIPES, FIT_BASELINE_EXPORT],
  pluginLayout: FIT_PLUGIN_LAYOUT,
  register,
  contributeScope,
  collectDashboardData: collectFitnessDashboardData,
  // ADR-0023 Phase 4: fitness contributes its namespaced `fitness:` Zod schema
  // (gate thresholds, disabledChecks, recipe) so the host composes +
  // strict-validates the whole config document before dispatch. Shared
  // targeting (targets/globalExcludes/checkOverrides) stays with
  // SignalersConfigSchema until 2.10.1.
  config: fitnessConfigDeclaration,
  initialize: async (): Promise<void> => {
    // ensureChecksLoaded() is called inside the executeFit / listChecks
    // / listRecipes paths, so a separate initialize() pass is not
    // strictly needed today. Left as a no-op so fitness has somewhere
    // to hang future tool-startup work (eager check-pack discovery,
    // catalog warming, etc.) without requiring a contract change.
  },
};
