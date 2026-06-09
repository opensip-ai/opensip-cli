/**
 * Pure builders that transform fitness recipe results into the run's
 * `SignalEnvelope` (the universal output currency, ADR-0011) and the
 * `FitDoneResult` that carries it — plus the formatting helpers they rely on
 * and the best-effort session persistence side effect invoked at the
 * `executeFit` boundary.
 *
 * Keeping these together (rather than per-output-shape) makes the
 * signal-shape mapping visible in one place: `buildFitEnvelope` maps check
 * violations to `Signal`s and `buildFitDoneResult` wraps the envelope.
 */

import {
  buildSignalEnvelope,
  type FitOptions,
  type SignalEnvelope,
  type UnitResult,
  type FitDoneResult,
} from '@opensip-tools/contracts';
import { currentScope, generatePrefixedId, logger } from '@opensip-tools/core';
import { SessionRepo } from '@opensip-tools/session-store';

import { buildFitnessSessionPayload } from '../../persistence/session-payload.js';
import { violationToSignal } from '../../signalers/violation-to-signal.js';

import { getPluginLoadErrors } from './check-loader.js';
import { buildFitVerboseDetail } from './envelope-view.js';
import { resolvedFitnessConfig } from './resolved-fitness-config.js';

import type { FitnessRecipeServiceCallbacks, CheckSummary } from '../../recipes/service-types.js';
import type { FitnessRecipeResult, RecipeCheckResult } from '../../recipes/types.js';
import type { SignalersConfig } from '../../signalers/types.js';
import type { Signal } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

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
  });
}

/** Input bundle for {@link buildFitDoneResult}: CLI args, recipe result, the run envelope, and signaler config. */
export interface BuildFitDoneArgs {
  args: FitOptions;
  fitnessResult: FitnessRecipeResult;
  envelope: SignalEnvelope;
  signalersConfig: SignalersConfig;
  recipeName: string | undefined;
  warnings?: readonly string[];
}

/**
 * Build the {@link FitDoneResult} the live renderer / non-TTY render path
 * consume. Carries the run's {@link SignalEnvelope} (the composition root
 * derives the terminal table + summary FROM it — one row per check unit) plus
 * the run label, the fail-threshold verdict, and non-fatal warnings.
 *
 * `shouldFail` (the exit-code driver) is NOT envelope.verdict.passed: it folds
 * in the configured `failOnErrors`/`failOnWarnings` thresholds and the
 * plugin-load-error gate, which the pure signal verdict cannot express.
 *
 * Pure builder: session persistence (SessionRepo.save) lives at the
 * `executeFit` call site (post-call), not here. The envelope is assembled once
 * in `executeFit` and threaded in so the gate, render, and session-payload
 * paths all consume the same envelope.
 */
export function buildFitDoneResult({ args, fitnessResult, envelope, signalersConfig, recipeName, warnings }: BuildFitDoneArgs): FitDoneResult {
  const { summary } = fitnessResult;

  // Determine exit code from the RESOLVED config thresholds (ADR-0023, Phase 4).
  // The host already merged flag > env > file > defaults into
  // `scope.toolConfig.fitness`, so reading it here is what makes the declared
  // env bindings (OPENSIP_FIT_FAIL_ON_ERRORS / OPENSIP_FIT_FAIL_ON_WARNINGS)
  // actually drive the gate — they were no-ops while this read the re-parsed
  // `signalersConfig.fitness.*`. Fall back to the file-sourced signalersConfig
  // (then the historical literal defaults) when no scope/toolConfig is present
  // (a config-less project, or a unit test not wrapped in runWithScope).
  // failOnErrors: fail if total errors >= this value (default: 1, 0 = never fail on errors)
  // failOnWarnings: fail if total warnings >= this value (default: 0 = never fail on warnings)
  const resolved = resolvedFitnessConfig();
  const failOnErrors = resolved?.failOnErrors ?? signalersConfig.fitness.failOnErrors ?? 1;
  const failOnWarnings = resolved?.failOnWarnings ?? signalersConfig.fitness.failOnWarnings ?? 0;
  const shouldFail =
    getPluginLoadErrors().length > 0 ||
    (failOnErrors > 0 && summary.totalErrors >= failOnErrors) ||
    (failOnWarnings > 0 && summary.totalWarnings >= failOnWarnings);

  const label = args.tags ? `tags: ${args.tags}` : `recipe ${recipeName ?? 'default'}`;

  // ADR-0021: carry the verbose findings body on the result so the shared
  // resultToView seam renders it identically in a TTY and a pipe (the old
  // TTY-only path left `fit --verbose | cat` empty).
  const verboseDetail = buildFitVerboseDetail(envelope, args);

  return {
    type: 'fit-done',
    label,
    cwd: args.cwd,
    envelope,
    shouldFail,
    configFound: true,
    warnings: warnings && warnings.length > 0 ? warnings : undefined,
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
      logger.debug({ evt: 'cli.check.start', module: 'cli:fit', checkSlug, index, total });
      onProgress?.(completedCount, total);
    },
    onCheckComplete(checkSlug: string, summary: CheckSummary, index: number, total: number) {
      logger.debug({ evt: 'cli.check.complete', module: 'cli:fit', checkSlug, passed: summary.passed, errors: summary.errors, warnings: summary.warnings, durationMs: summary.durationMs });
      completedCount++;
      onProgress?.(completedCount, total);
    },
  };
}

// ---------------------------------------------------------------------------
// Session persistence (best-effort side effect)
// ---------------------------------------------------------------------------

/**
 * Best-effort session persistence — invoked when `executeFit` is called
 * with a `datastore` opt. Maps the run's {@link SignalEnvelope} onto the
 * generic `StoredSession` row (`score`/`passed`/`timestamp` from the
 * envelope's verdict + identity) and the dashboard-shaped opaque payload
 * (derived from the envelope's signals/units, 4→2 severity). Errors are
 * caught and logged so a write failure never fails the run.
 */
export function persistFitSession(
  datastore: DataStore,
  args: FitOptions,
  envelope: SignalEnvelope,
  durationMs: number,
): void {
  try {
    const repo = new SessionRepo(datastore);
    repo.save({
      id: generatePrefixedId('fit'),
      tool: 'fit',
      timestamp: envelope.createdAt,
      cwd: args.cwd,
      recipe: envelope.recipe,
      score: envelope.verdict.score,
      passed: envelope.verdict.passed,
      durationMs,
      // Fitness-owned opaque detail (summary + per-check findings), derived
      // from the envelope's signals/units. The generic session row above
      // holds zero fitness vocabulary; the dashboard reads this payload to
      // render the Fitness tab.
      payload: buildFitnessSessionPayload(envelope),
    });
  } catch (error) {
    logger.warn({
      evt: 'cli.fit.session.save_failed',
      module: 'cli:fit',
      msg: 'Failed to persist fit session — continuing without history write',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
