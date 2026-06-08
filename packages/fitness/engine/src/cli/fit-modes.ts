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
  type SignalEnvelope,
  type StoredSession,
} from '@opensip-tools/contracts';
import { resolveSession } from '@opensip-tools/session-store';

import {
  saveBaseline,
  compareToBaseline,
  renderGateCompareOutput,
  GateBaselineMissingError,
  GateBaselineInvalidError,
} from '../gate.js';
import { FitBaselineRepo } from '../persistence/baseline-repo.js';
import { fitReplayFromSession } from '../persistence/session-replay.js';

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

/**
 * Deliver the run's signal envelope to the composition-root-owned effectful
 * sinks (ADR-0011 / ADR-0008): best-effort cloud sync + the `--report-to`
 * SARIF upload (which owns exit code 4). Called once per mode, after the
 * render/emit. `runFailed` is the real exit decision (`shouldFail` /
 * gate-degraded), so a `--report-to` upload failure never masks a genuine
 * check/gate failure. No-op when neither cloud nor `--report-to` is active.
 */
async function deliverFitSignals(
  cli: ToolCliContext,
  envelope: SignalEnvelope,
  args: FitOptions,
  runFailed: boolean,
): Promise<void> {
  await cli.deliverSignals(envelope, {
    cwd: args.cwd,
    reportTo: args.reportTo,
    apiKey: args.apiKey,
    runFailed,
  });
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

export async function runShowMode(args: FitOptions, cli: ToolCliContext): Promise<void> {
  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (datastore === undefined) {
    await emitShowError(args, cli, 'datastore-unavailable', 'session replay requires a datastore');
    return;
  }
  const resolved = resolveSession(datastore, { ref: args.show ?? 'latest', tool: 'fit' });
  if (!resolved.ok) {
    await emitShowError(args, cli, resolved.reason, resolved.detail);
    return;
  }

  try {
    const replay = fitReplayFromSession(resolved.session);
    if (args.json) {
      cli.emitJson(sessionShowJson(resolved.session, replay));
      return;
    }
    await cli.render(replay.result);
  } catch (error) {
    await emitShowError(
      args,
      cli,
      'decode-error',
      error instanceof Error ? error.message : String(error),
    );
  }
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
  if (fitResult.envelope === undefined) {
    // 2.12.0 (§5.5): a failed `--json` run emits a structured `status:'error'`
    // CommandOutcome (the host wraps + sets the exit code), not a bare `{ error }`.
    cli.emitError({ message: fitResult.result.message, exitCode: fitResult.result.exitCode });
    return;
  }
  const runFailed = fitResult.result.shouldFail === true;
  if (runFailed) {
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
  }
  // ADR-0011: emit the signal envelope through the shared `formatSignalJson`
  // formatter (the root owns stdout). No per-tool re-stringification.
  cli.emitEnvelope(fitResult.envelope);
  // Warnings collected during the run go to stderr so JSON consumers still
  // see them without contaminating the structured stdout payload.
  emitWarningsToStderr(fitResult.result);
  // Effectful egress lives at the composition root: cloud sync + `--report-to`
  // (which owns exit 4). Called once, after the JSON is on stdout.
  await deliverFitSignals(cli, fitResult.envelope, args, runFailed);
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
  if (process.stdout.isTTY === true) {
    await cli.renderLive(liveViewKey, args);
  } else {
    // Non-TTY (pipe / CI / redirect): the animated Ink live view is a TTY-only
    // affordance and would emit garbled frames. Run the engine and emit the
    // static `fit-done` result through the seam, which dual-renders it as plain
    // text (`renderToText`) — the same content the TTY user's final frame
    // shows. Exit-code policy mirrors the live runner (fit-runner.tsx): an
    // error result carries its own code; a passing run that breached the fail
    // threshold exits RUNTIME_ERROR. Warnings are rendered inline by the
    // fit-done view, so we don't also write them to stderr here.
    const fitResult = await executeFit(args, {
      datastore: cli.scope.datastore() as DataStore | undefined,
    });
    if (fitResult.envelope === undefined) {
      cli.setExitCode(fitResult.result.exitCode);
      await cli.render(fitResult.result);
    } else {
      const runFailed = fitResult.result.shouldFail === true;
      if (runFailed) {
        cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
      }
      await cli.render(fitResult.result);
      // Effectful egress at the composition root (cloud + `--report-to`),
      // composing with non-TTY runs (CI), not just the TTY live view.
      await deliverFitSignals(cli, fitResult.envelope, args, runFailed);
    }
  }
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
  if (fitResult.envelope === undefined) {
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
  const { envelope } = fitResult;
  // Surface non-fatal warnings before the gate output so the user sees them
  // alongside the run summary. Safe here because gate mode is non-Ink.
  emitWarningsToStderr(fitResult.result);
  try {
    if (args.gateSave === true) {
      saveBaseline(envelope, repo);
      await cli.render({
        type: 'gate-done',
        lines: [
          'Baseline saved (project SQLite store)',
          `  ${envelope.units.length} check(s), ${envelope.signals.length} finding(s)`,
        ],
      });
      // ADR-0020: gate-save records the baseline AND hard-fails the step on a
      // fail-threshold breach (`failOnErrors`/`failOnWarnings`), mirroring live
      // and JSON mode. The CI step is therefore the honest pass/fail signal —
      // it no longer exits 0 while error-level findings exist, so enforcement
      // does not rely solely on the downstream Code Scanning net-new ratchet +
      // branch protection (external config the release-gate ADR-0017 explicitly
      // declined to trust). The SARIF export runs in a separate `if: always()`
      // CI step, so the baseline + net-new PR annotations survive a failed gate.
      // `runFailed` dominates a `--report-to` upload failure (exit 4) so a
      // report failure never masks the gate verdict (same rule as gate-compare).
      const runFailed = fitResult.result.shouldFail === true;
      if (runFailed) {
        cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
      }
      await deliverFitSignals(cli, envelope, args, runFailed);
      return;
    }
    const result = compareToBaseline(envelope, repo);
    await cli.render({ type: 'gate-done', lines: renderGateCompareOutput(result).split('\n') });
    cli.setExitCode(result.degraded ? EXIT_CODES.RUNTIME_ERROR : EXIT_CODES.SUCCESS);
    // A gate regression dominates a `--report-to` upload failure: pass
    // `degraded` as runFailed so exit 4 never masks the gate verdict.
    await deliverFitSignals(cli, envelope, args, result.degraded);
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

async function emitShowError(
  args: Pick<FitOptions, 'json'>,
  cli: ToolCliContext,
  reason: string,
  detail: string,
): Promise<void> {
  if (args.json) {
    // emitError sets the exit code itself (process exit == reported outcome).
    cli.emitError({ message: detail, exitCode: EXIT_CODES.CONFIGURATION_ERROR, code: reason });
    return;
  }
  cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
  await cli.render({
    type: 'error',
    message: detail,
    exitCode: EXIT_CODES.CONFIGURATION_ERROR,
  });
}

function sessionShowJson(
  session: StoredSession,
  replay: ReturnType<typeof fitReplayFromSession>,
): unknown {
  return {
    session: {
      id: session.id,
      tool: session.tool,
      timestamp: session.timestamp,
      recipe: session.recipe,
      cwd: session.cwd,
      score: session.score,
      passed: session.passed,
      durationMs: session.durationMs,
    },
    fidelity: replay.fidelity,
    envelope: replay.envelope,
  };
}
