/**
 * @fileoverview Mode helpers for the `fit` Commander action.
 *
 * The `fit` subcommand dispatches to one of five mutually exclusive
 * modes (gate, list, recipes, json, live) based on the parsed flags.
 * Each mode is small and self-contained; isolating them in this module
 * keeps `tool.ts` focused on Commander wiring and lets the runner
 * branches be tested independently.
 *
 * The exported helpers all take a normalized `CliArgs` (the bridge
 * shape executeFit consumes) plus the `ToolCliContext` the dispatcher
 * provides to each tool.
 */

/* eslint-disable sonarjs/deprecation -- intentional adapter usage; CliArgs bridge between FitOptions and executeFit's legacy shape */
import {
  EXIT_CODES,
  mapToolErrorToExitCode,
  type CliArgs,
  type FitOptions,
} from '@opensip-tools/contracts';
/* eslint-enable sonarjs/deprecation */

import { executeFit } from './fit.js';
import { listChecks } from './list-checks.js';
import { listRecipes } from './list-recipes.js';
import {
  saveBaseline,
  compareToBaseline,
  renderGateCompareOutput,
  GateBaselineMissingError,
  GateBaselineInvalidError,
} from '../gate.js';
import { FitBaselineRepo } from '../persistence/baseline-repo.js';

import type { ToolCliContext } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

/**
 * Bridge `FitOptions` (Commander-parsed) to the legacy `CliArgs` shape
 * that `executeFit` and friends consume.
 */
// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
export function fitOptsToCliArgs(opts: FitOptions & { quiet?: boolean; open?: boolean }): CliArgs {
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

/**
 * Emit any non-fatal warnings collected during the run to stderr. Safe to
 * call from non-Ink paths (JSON, gate modes) because Ink is not managing
 * the screen there. The live renderer surfaces these through Ink in the
 * summary block instead.
 */
export function emitWarningsToStderr(result: { warnings?: readonly string[] }): void {
  if (!result.warnings || result.warnings.length === 0) return;
  for (const msg of result.warnings) {
    process.stderr.write(`opensip-tools: ${msg}\n`);
  }
}

// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
export async function runListMode(args: CliArgs, cli: ToolCliContext): Promise<void> {
  const result = await listChecks(args.cwd);
  if (args.json) { cli.emitJson(result); return; }
  await cli.render(result);
}

// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
export async function runRecipesMode(args: CliArgs, cli: ToolCliContext): Promise<void> {
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
export async function runJsonMode(args: CliArgs, cli: ToolCliContext): Promise<void> {
  const fitResult = await executeFit(args, { datastore: cli.scope.datastore() as DataStore | undefined });
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
 * Visual mode — Ink-rendered live results. The CLI supplies the
 * renderer via `cli.renderLive()` so this file doesn't depend on the
 * CLI package directly. After the run, optionally launches the HTML
 * dashboard.
 */
export async function runLiveMode(
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
  args: CliArgs,
  cli: ToolCliContext,
  liveViewKey: string,
  openRequested: boolean,
): Promise<void> {
  await cli.renderLive(liveViewKey, args);
  await cli.maybeOpenDashboard({
    openRequested,
    jsonOutput: Boolean(args.json),
  });
}

// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
export async function runGateMode(args: CliArgs, cli: ToolCliContext): Promise<void> {
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
  const datastore = cli.scope.datastore() as DataStore;
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
    // Gate mode is plain-text (not Ink), so we render the error
    // ourselves to stderr instead of letting it escape to the CLI's
    // Ink-based `handleParseError`. The exit-code policy still flows
    // through the canonical `mapToolErrorToExitCode` so a gate-mode
    // failure gets the same exit code an Ink-mode failure would —
    // GateBaselineMissingError (extends ConfigurationError) → 2,
    // GateBaselineInvalidError (extends SystemError) → 1. Unknown
    // errors rethrow to the central handler.
    if (error instanceof GateBaselineMissingError || error instanceof GateBaselineInvalidError) {
      cli.logger.warn({
        evt: 'cli.gate.baseline_error',
        module: 'cli:gate',
        mode: args.gateSave === true ? 'save' : 'compare',
        errorType: error.name,
        reason: error.message,
      });
      cli.setExitCode(mapToolErrorToExitCode(error));
      process.stderr.write(`Error: ${error.message}\n`);
      return;
    }
    throw error;
  }
}
