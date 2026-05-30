// @fitness-ignore-file detached-promises -- CLI mode dispatch: render helpers / process.stdout.write / setExitCode invocations are synchronous; heuristic flags inside async handlers.
// @fitness-ignore-file no-non-null-assertions -- mode-helpers narrow result.type before accessing branch-specific fields; the assertions are typescript-narrowing aids where the discriminant already proves the case.
/**
 * @fileoverview Mode helpers for the `fit` Commander action.
 *
 * The `fit` subcommand dispatches to one of five mutually exclusive
 * modes (gate, list, recipes, json, live) based on the parsed flags.
 * Each mode is small and self-contained; isolating them in this module
 * keeps `tool.ts` focused on Commander wiring and lets the runner
 * branches be tested independently.
 *
 * The exported helpers all take the Commander-parsed `FitOptions` plus
 * the `ToolCliContext` the dispatcher provides to each tool.
 */

import {
  EXIT_CODES,
  mapToolErrorToExitCode,
  type FitOptions,
} from '@opensip-tools/contracts';

import {
  saveBaseline,
  compareToBaseline,
  renderGateCompareOutput,
  GateBaselineMissingError,
  GateBaselineInvalidError,
} from '../gate.js';
import { FitBaselineRepo } from '../persistence/baseline-repo.js';

import { executeFit } from './fit.js';
import { listChecks } from './list-checks.js';
import { listRecipes } from './list-recipes.js';

import type { ToolCliContext } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

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

export async function runListMode(args: FitOptions, cli: ToolCliContext): Promise<void> {
  const result = await listChecks(args.cwd);
  if (args.json) { cli.emitJson(result); return; }
  await cli.render(result);
}

export async function runRecipesMode(args: FitOptions, cli: ToolCliContext): Promise<void> {
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
export async function runJsonMode(args: FitOptions, cli: ToolCliContext): Promise<void> {
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
  args: FitOptions,
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

export async function runGateMode(args: FitOptions, cli: ToolCliContext): Promise<void> {
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
