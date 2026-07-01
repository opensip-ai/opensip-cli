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
  emitAgentFilteredJsonOutput,
  EXIT_CODES,
  runHostGateDispatch,
  type FitOptions,
  type SignalEnvelope,
  type StoredSession,
} from '@opensip-cli/contracts';
import {
  ConfigurationError,
  deriveRunOutcome,
  SystemError,
  type ToolCliContext,
  type ToolRunCompletion,
  type ToolSessionContribution,
  type ToolRunOutcome,
} from '@opensip-cli/core';
import { resolveSession } from '@opensip-cli/session-store';

import { fitReplayFromSession } from '../persistence/session-replay.js';

import { renderGateCompareOutput } from './fit/gate-compare-render.js';
import { buildFitnessSessionPayload } from './fit/result-builders.js';
import { listChecks } from './fit-list.js';
import { listRecipes } from './fit-recipes.js';
import { executeFit } from './fit.js';

import type { DataStore } from '@opensip-cli/datastore';

/**
 * The portion of a {@link ToolRunCompletion} fit's static modes return: the
 * generic-session contribution (host-owned-run-timing Phase 3). The host run
 * plane persists it after the handler resolves; the tool writes nothing itself.
 */
type FitRunCompletion = Pick<ToolRunCompletion, 'session'>;

/**
 * Build fit's generic-session contribution from a completed run envelope
 * (host-owned-run-timing Phase 3). The static modes RETURN this; the host run
 * plane persists it after the handler resolves — no tool-side session write.
 */
function fitSessionContribution(
  args: FitOptions,
  envelope: SignalEnvelope,
  runOutcome?: ToolRunOutcome,
): ToolSessionContribution {
  const passed = envelope.verdict.passed;
  return {
    tool: 'fit',
    cwd: args.cwd,
    recipe: envelope.recipe,
    score: envelope.verdict.score,
    passed,
    runOutcome: deriveRunOutcome({ passed, explicit: runOutcome }),
    payload: buildFitnessSessionPayload(envelope),
  };
}

/**
 * Build fit's run completion from the run envelope (host-owned-run-timing
 * Phase 3): the generic-session contribution the host run plane persists.
 */
function fitRunCompletion(
  args: FitOptions,
  envelope: SignalEnvelope,
  runOutcome?: ToolRunOutcome,
): FitRunCompletion {
  return {
    session: fitSessionContribution(args, envelope, runOutcome),
  };
}

// persistFitRun removed (Phase 3). The three mode bodies (json/live-fallback/gate)
// now RETURN a FitRunCompletion (the `session` contribution above) from the
// handler/live renderer; the host run plane persists it and stamps
// startedAt/completedAt/durationMs from the invocation RunTimer. There is no
// tool-side generic-session writer (the `runSession.record`
// seam was removed in Phase 6).

/**
 * Emit any non-fatal warnings collected during the run to stderr. Safe to
 * call from non-Ink paths (JSON, gate modes) because Ink is not managing
 * the screen there. The live renderer surfaces these through Ink in the
 * summary block instead.
 */
function emitWarningsToStderr(result: { warnings?: readonly string[] }): void {
  if (!result.warnings || result.warnings.length === 0) return;
  for (const msg of result.warnings) {
    process.stderr.write(`opensip: ${msg}\n`);
  }
}

/**
 * Deliver the run's signal envelope to the composition-root-owned effectful
 * sinks (ADR-0011 / ADR-0008): best-effort cloud sync + the `--report-to`
 * SARIF upload — and, since ADR-0035, the host-owned FINDINGS exit code.
 *
 * Normal runs OMIT `runFailed`: the host derives the findings exit from
 * `envelope.verdict.passed` (the single verdict). The gate-COMPARE mode passes
 * its baseline-diff predicate (`degraded`), which is not expressible over the
 * run's verdict; the host honours that override and a `--report-to` upload
 * failure never masks the gate verdict. No-op when neither sink is active.
 */
async function deliverFitSignals(
  cli: ToolCliContext,
  envelope: SignalEnvelope,
  args: FitOptions,
  runFailed?: boolean,
): Promise<void> {
  await cli.deliverSignals(envelope, {
    cwd: args.cwd,
    reportTo: args.reportTo,
    apiKey: args.apiKey,
    ...(runFailed === undefined ? {} : { runFailed }),
  });
}

export async function runListMode(args: FitOptions, cli: ToolCliContext): Promise<void> {
  const result = await listChecks(args.cwd);
  if (args.json === true) {
    cli.emitJson(result);
    return;
  }
  await cli.render(result);
}

export async function runRecipesMode(args: FitOptions, cli: ToolCliContext): Promise<void> {
  const result = await listRecipes(args.cwd);
  if (args.json === true) {
    cli.emitJson(result);
    return;
  }
  await cli.render(result);
}

export async function runShowMode(args: FitOptions, cli: ToolCliContext): Promise<void> {
  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (datastore === undefined) {
    await emitShowError(args, cli, 'datastore-unavailable', 'session replay requires a datastore');
    return;
  }
  const resolved = resolveSession(datastore, {
    ref: args.show ?? 'latest',
    tool: 'fit',
  });
  if (!resolved.ok) {
    await emitShowError(args, cli, resolved.reason, resolved.detail);
    return;
  }

  try {
    const replay = fitReplayFromSession(resolved.session);
    if (args.json === true) {
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
export async function runJsonMode(
  args: FitOptions,
  cli: ToolCliContext,
): Promise<FitRunCompletion | undefined> {
  const fitResult = await executeFit(args);
  if (fitResult.envelope === undefined) {
    // ADR-0060: command-error — structured diagnostic, no findings envelope or session.
    await cli.reportFailure({ ...fitResult.result, jsonRequested: true });
    return undefined;
  }
  // ADR-0085: agent filters are presentation-only — egress/session use the
  // unfiltered envelope; filtered output goes through emitJson/emitRaw.
  emitAgentFilteredJsonOutput(cli, fitResult.envelope, args);
  // Warnings collected during the run go to stderr so JSON consumers still
  // see them without contaminating the structured stdout payload. They ride on
  // the executeFit result bundle now (a sibling field), not on the render-only
  // RunPresentation (envelope-first-presentation plan).
  emitWarningsToStderr(fitResult);
  // ADR-0011/ADR-0035: the composition root owns effectful egress (cloud +
  // `--report-to`, exit 4) AND the findings exit code (derived from the
  // envelope verdict). Called once, after the JSON is on stdout.
  await deliverFitSignals(cli, fitResult.envelope, args);
  // Host-owned persistence (host-owned-run-timing Phases 3 + 5): RETURN the
  // session + dashboard contribution; the host persists both after the handler
  // resolves.
  return fitRunCompletion(args, fitResult.envelope, fitResult.runOutcome);
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
): Promise<FitRunCompletion | undefined> {
  // The TTY live path persists via the host (renderLive → completeLiveRender),
  // so this returns undefined there (no double-write). The non-TTY path returns
  // the contribution for the host to persist after the handler resolves.
  let completion: FitRunCompletion | undefined;
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
    const fitResult = await executeFit(args);
    if (fitResult.envelope === undefined) {
      cli.setExitCode(fitResult.result.exitCode);
      await cli.render(fitResult.result);
    } else {
      await cli.render(fitResult.result);
      // Effectful egress + host-owned findings exit at the composition root
      // (ADR-0035), composing with non-TTY runs (CI), not just the TTY live view.
      await deliverFitSignals(cli, fitResult.envelope, args);
      completion = fitRunCompletion(args, fitResult.envelope, fitResult.runOutcome);
    }
  }
  await cli.maybeOpenReport({
    openRequested,
    jsonOutput: args.json === true,
  });
  return completion;
}

export async function runGateMode(
  args: FitOptions,
  cli: ToolCliContext,
): Promise<FitRunCompletion | undefined> {
  if (args.gateSave === true && args.gateCompare === true) {
    cli.logger.warn({
      evt: 'cli.gate.config_error',
      module: 'cli:gate',
      reason: 'mutually-exclusive flags',
      msg: '--gate-save and --gate-compare specified together',
    });
    await cli.reportFailure({
      message: 'Error: --gate-save and --gate-compare are mutually exclusive.',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      jsonRequested: args.json === true,
    });
    return undefined;
  }
  // Run on the main thread (ADR-0028 — engine is persistence-free). The session
  // contribution is RETURNED (host-owned-run-timing Phase 3); the host persists
  // it so gate-save / gate-compare runs land in history alongside live runs.
  const fitResult = await executeFit(args);
  if (fitResult.envelope === undefined) {
    cli.logger.warn({
      evt: 'cli.gate.fit_failed',
      module: 'cli:gate',
      mode: args.gateSave === true ? 'save' : 'compare',
      reason: fitResult.result.message,
    });
    await cli.reportFailure({
      ...fitResult.result,
      jsonRequested: args.json === true,
    });
    return undefined;
  }
  // ADR-0036: the envelope arrives fingerprint-stamped — `buildFitEnvelope`
  // passes fit's message-hash strategy to `buildSignalEnvelope`, which stamps
  // at construction. The host seams only read `signal.fingerprint`.
  const envelope: SignalEnvelope = fitResult.envelope;
  const completion = fitRunCompletion(args, envelope, fitResult.runOutcome);
  // Surface non-fatal warnings before the gate output so the user sees them
  // alongside the run summary. Safe here because gate mode is non-Ink. Warnings
  // ride on the result bundle now (sibling field), not the RunPresentation.
  emitWarningsToStderr(fitResult);
  try {
    await runHostGateDispatch({
      cli,
      tool: 'fitness',
      envelope,
      mode: args.gateSave === true ? 'save' : 'compare',
      deliver: {
        cwd: args.cwd,
        reportTo: args.reportTo,
        apiKey: args.apiKey,
      },
      renderSaveLines: ({ envelope }) => [
        'Baseline saved (project SQLite store)',
        `  ${envelope.units.length} check(s), ${envelope.signals.length} finding(s)`,
      ],
      renderCompareLines: ({ result }) => renderGateCompareOutput(result).split('\n'),
    });
    return completion;
  } catch (error) {
    // Gate mode is plain-text (not Ink), so we render the error
    // ourselves to stderr instead of letting it escape to the CLI's
    // Ink-based `handleParseError`. The exit-code policy still flows
    // through the canonical `mapToolErrorToExitCode` so a gate-mode
    // failure gets the same exit code an Ink-mode failure would — the
    // host compare seam throws ConfigurationError on a missing baseline
    // (→ 2); a datastore-integrity SystemError → 1. Unknown errors
    // rethrow to the central handler.
    if (error instanceof ConfigurationError || error instanceof SystemError) {
      await cli.reportFailure({
        error,
        message: `Error: ${error.message}`,
        jsonRequested: args.json === true,
        log: {
          evt: 'cli.gate.baseline_error',
          level: 'warn',
          data: {
            module: 'cli:gate',
            mode: args.gateSave === true ? 'save' : 'compare',
            errorType: error.name,
            reason: error.message,
          },
        },
      });
      return undefined;
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
  await cli.reportFailure({
    message: detail,
    exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    code: reason,
    jsonRequested: args.json === true,
  });
}

// @graph-ignore-next-line graph:near-duplicate-function-body -- fit/graph/sim JSON replay projections intentionally preserve each tool's command surface.
function sessionShowJson(
  session: StoredSession,
  replay: ReturnType<typeof fitReplayFromSession>,
): unknown {
  return {
    session: {
      id: session.id,
      tool: session.tool,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
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
