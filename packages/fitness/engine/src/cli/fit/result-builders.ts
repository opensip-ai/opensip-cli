/**
 * Pure builders that transform fitness recipe results into the run's
 * `SignalEnvelope` (the universal output currency, ADR-0011) and the
 * render-only `RunPresentation` that carries it — plus the formatting helpers
 * they rely on and the best-effort session persistence side effect invoked at
 * the `executeFit` boundary.
 *
 * Keeping these together (rather than per-output-shape) makes the
 * signal-shape mapping visible in one place: `buildFitEnvelope` maps check
 * violations to `Signal`s and `buildFitPresentation` wraps the envelope in the
 * render adjunct (envelope-first-presentation plan; replaced the old per-tool
 * fit done-result builder).
 */

import {
  buildSignalEnvelope,
  type FitOptions,
  type SignalEnvelope,
  type UnitResult,
  type RunPresentation,
} from '@opensip-cli/contracts';
import {
  currentScope,
  logger,
  resolveVerdictPolicy,
  type Signal,
  type VerdictPolicy,
} from '@opensip-cli/core';

import { fitnessFingerprintStrategy } from '../../baseline-strategy.js';
import { violationToSignal } from '../../signalers/violation-to-signal.js';

import { getPluginLoadErrors } from './check-loader.js';
import { buildFitVerboseDetail } from './envelope-view.js';
import { resolvedFitnessConfig } from './resolved-fitness-config.js';

import type { FitnessRecipeServiceCallbacks, CheckSummary } from '../../recipes/service-types.js';
import type { FitnessRecipeResult, RecipeCheckResult } from '../../recipes/types.js';
import type { SignalersConfig } from '../../signalers/types.js';

/**
 * Resolve fit's findings policy (ADR-0035). Reserved keys
 * `failOnErrors`/`failOnWarnings` come from the host-RESOLVED
 * `scope.toolConfig.fitness` (flag>env>file>defaults, ADR-0023), falling back to
 * the file-sourced `signalersConfig.fitness` when no scope/toolConfig is present
 * (a config-less project, or `executeFit` invoked off the CLI dispatch path),
 * then to the host default `{1, 0}`. This is fit's historical gate resolution,
 * now expressed as a VerdictPolicy the host verdict consumes — so
 * `envelope.verdict.passed` is the single exit driver.
 */
export function resolveFitVerdictPolicy(signalersConfig: SignalersConfig): VerdictPolicy {
  const resolved = resolvedFitnessConfig();
  if (resolved !== undefined) {
    return resolveVerdictPolicy('fitness');
  }

  return {
    failOnErrors: signalersConfig.fitness.failOnErrors ?? 1,
    failOnWarnings: signalersConfig.fitness.failOnWarnings ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Envelope builder (ADR-0011, Phase 6) — the canonical post-run transform
// ---------------------------------------------------------------------------

/** Per-check error string for the unit sidecar: the check's own error, or a timeout marker. */
function unitError(cr: RecipeCheckResult): string | undefined {
  if (cr.error !== undefined) return cr.error;
  if (cr.timedOut === true) return 'timed out';
  return undefined;
}

/**
 * Assemble the fit run's {@link SignalEnvelope} — the universal output
 * currency the composition root renders (table), emits (`--json`), and
 * delivers (cloud + `--report-to`).
 *
 * Each check violation becomes one {@link Signal} (`source === ruleId ===
 * checkSlug`) via {@link violationToSignal}; every check that ran produces one
 * {@link UnitResult} row (so a clean check still appears in the table). The
 * fitness-only `Validated`/`Ignores` columns ride on the unit as
 * `filesValidated`/`itemType`/`ignoredCount` (per-unit facts a flat signal
 * list cannot express). The verdict/summary are computed centrally by
 * {@link buildSignalEnvelope} so all three tools agree on "passed ⇔ no
 * critical/high".
 *
 * Pure: the only clock read (`createdAt`) and the run id come from the caller's
 * scope, matching graph/sim's envelope builders.
 */
export function buildFitEnvelope(
  fitnessResult: FitnessRecipeResult,
  recipeName: string | undefined,
  signalersConfig: SignalersConfig,
): SignalEnvelope {
  const { checkResults } = fitnessResult;

  const signals: Signal[] = [];
  const units: UnitResult[] = [];
  for (const cr of checkResults) {
    for (const violation of cr.violations ?? []) {
      signals.push(violationToSignal(cr.checkSlug, violation));
    }
    units.push({
      slug: cr.checkSlug,
      passed: cr.passed,
      violationCount: cr.violationCount,
      durationMs: cr.durationMs,
      error: unitError(cr),
      filesValidated: cr.totalItems,
      itemType: cr.itemType,
      ignoredCount: cr.ignoredCount,
    });
  }

  return buildSignalEnvelope({
    tool: 'fit',
    recipe: recipeName,
    runId: currentScope()?.runId ?? '',
    createdAt: new Date().toISOString(),
    units,
    signals,
    // ADR-0035: the host-owned verdict reads fit's resolved
    // failOnErrors/failOnWarnings (scope.toolConfig.fitness, signalersConfig
    // fallback, then {1,0}). Plugin-load errors occur before any unit exists, so
    // they ride runFaulted.
    policy: resolveFitVerdictPolicy(signalersConfig),
    runFaulted: getPluginLoadErrors().length > 0,
    // ADR-0036: fit's message-hash identity (line-shift-tolerant), stamped at
    // construction so EVERY fit envelope — live/json/cloud, not only the gate
    // path — carries gate-ready fingerprints.
    fingerprintStrategy: fitnessFingerprintStrategy,
  });
}

/** Input bundle for {@link buildFitPresentation}: CLI args, recipe result, the run envelope, and signaler config. */
export interface BuildFitPresentationArgs {
  args: FitOptions;
  fitnessResult: FitnessRecipeResult;
  envelope: SignalEnvelope;
  signalersConfig: SignalersConfig;
  recipeName: string | undefined;
}

/**
 * Build the render-only {@link RunPresentation} the live renderer / non-TTY
 * render path consume (envelope-first-presentation plan; replaced the old
 * per-tool fit done-result builder). Carries the run's {@link SignalEnvelope}
 * (the composition root derives the terminal table + summary AND the findings
 * exit code FROM it — one row per check unit, `envelope.verdict.passed` the
 * single verdict) plus the optional verbose detail body.
 *
 * No `durationMs` is set: fit's summary duration is the envelope unit-sum (the
 * presentation renderer falls back to it when no override is supplied), matching
 * the pre-migration render byte-for-byte. The dropped `*DoneResult` fields
 * (`label`/`cwd`/`configFound`) were not consumed by the table view; `warnings`
 * is NOT a display field the view renders — it rides on the `executeFit` result
 * bundle (a sibling field) so `emitWarningsToStderr` and the live runner keep
 * surfacing it.
 *
 * ADR-0035: the exit code is not carried on the result. `verdict.passed`
 * (computed with fit's resolved failOnErrors/failOnWarnings policy + plugin-load
 * `runFaulted`) is the single exit driver; the host derives it in `deliverSignals`.
 *
 * Pure builder: session persistence lives at the `executeFit` call site
 * (post-call), not here. The envelope is assembled once in `executeFit` and
 * threaded in so the gate, render, and session-payload paths all consume the
 * same envelope.
 */
export function buildFitPresentation({
  args,
  envelope,
}: BuildFitPresentationArgs): RunPresentation {
  // ADR-0021: carry the verbose findings body on the presentation so the shared
  // resultToView seam renders it identically in a TTY and a pipe (the old
  // TTY-only path left `fit --verbose | cat` empty).
  const verboseDetail = buildFitVerboseDetail(envelope, args);

  return {
    type: 'run-presentation',
    tool: 'fitness',
    envelope,
    ...(verboseDetail === undefined ? {} : { verboseDetail }),
  };
}

// ---------------------------------------------------------------------------
// Recipe-service progress callbacks
// ---------------------------------------------------------------------------

/**
 * Wire up CLI-side progress callbacks for the recipe service.
 *
 * Monotonic completed-count: the service fires `onCheckStart(slug,
 * displayIndex, total)` when a check STARTS and
 * `onCheckComplete(slug, summary, displayIndex, total)` when it
 * FINISHES. Under parallel execution `displayIndex` is the check's
 * position in the queue (1..total), not "how many have completed" — so
 * the last-started check's index hops above the current completion
 * tally and then "resets" down when an earlier check finishes (the UI
 * showed `147/148 → 121/148 → 78/148`).
 *
 * The progress bar wants a monotonic counter. We track completed
 * locally, increment only on `onCheckComplete`, and ignore
 * `onCheckStart`'s index. The counter is strictly non-decreasing and
 * always reflects "N of M checks done."
 */
export function buildFitCallbacks(
  onProgress?: (completed: number, total: number) => void,
): FitnessRecipeServiceCallbacks {
  let completedCount = 0;
  return {
    onCheckStart(checkSlug: string, index: number, total: number) {
      logger.debug({
        evt: 'cli.check.start',
        module: 'cli:fit',
        checkSlug,
        index,
        total,
      });
      onProgress?.(completedCount, total);
    },
    onCheckComplete(checkSlug: string, summary: CheckSummary, index: number, total: number) {
      logger.debug({
        evt: 'cli.check.complete',
        module: 'cli:fit',
        checkSlug,
        passed: summary.passed,
        errors: summary.errors,
        warnings: summary.warnings,
        durationMs: summary.durationMs,
      });
      completedCount++;
      onProgress?.(completedCount, total);
    },
  };
}

// host-owned-run-timing Phase 3: the production `persistFitSession` helper was
// removed. Generic session rows are now persisted exclusively by the host run
// plane from the `ToolSessionContribution` the fit modes RETURN (see fit-modes /
// fit-command-spec). The only remaining session writer is the host.

export { buildFitnessSessionPayload } from '../../persistence/session-payload.js';
