/**
 * Pure builders that transform fitness recipe results into the public
 * CLI output shapes (`CliOutput`, `FitDoneResult`) — plus the
 * formatting helpers they rely on and the best-effort session
 * persistence side effect invoked at the `executeFit` boundary.
 *
 * Keeping these together (rather than per-output-shape) makes the
 * finding-shape mapping visible in one place: both `buildCliOutput` and
 * `buildFitDoneResult` flatten check violations into the same `Finding`
 * shape, and any change to that shape must be paired across both.
 */

import {
  passRate,
  type FitOptions,
  type CliOutput,
  type TableRow,
  type SummaryOptions,
  type FitDoneResult,
} from '@opensip-tools/contracts';
import { SessionRepo } from '@opensip-tools/session-store';
import { generatePrefixedId, logger } from '@opensip-tools/core';

import { buildFitnessSessionPayload } from '../../persistence/session-payload.js';

import { getPluginLoadErrors } from './check-loader.js';
import { getDisplayName } from './display-registry.js';

import type { FitnessRecipeServiceCallbacks, CheckSummary } from '../../recipes/service-types.js';
import type { FitnessRecipeResult } from '../../recipes/types.js';
import type { SignalersConfig } from '../../signalers/types.js';
import type { DataStore } from '@opensip-tools/datastore';

// ---------------------------------------------------------------------------
// Formatting helpers (used to build TableRow data)
// ---------------------------------------------------------------------------

/** Formats a millisecond duration as "Xms" under 1s, "X.Ys" otherwise. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Renders a "validated" table column showing item count with singular/plural noun. */
export function formatValidatedColumn(totalItems: number | undefined, itemType = 'items'): string {
  // No meaningful count: external tool checks, errored checks, or checks with no file scanning
  if (!totalItems) return '—';
  // Use singular for count of 1, plural otherwise (e.g., "1 file", "450 files", "13 packages")
  const singular = itemType.endsWith('s') ? itemType.slice(0, -1) : itemType;
  return totalItems === 1 ? `${totalItems} ${singular}` : `${totalItems} ${itemType}`;
}

function rowStatus(cr: { timedOut?: boolean; passed: boolean }): 'TIMEOUT' | 'PASS' | 'FAIL' {
  if (cr.timedOut) return 'TIMEOUT';
  return cr.passed ? 'PASS' : 'FAIL';
}

// ---------------------------------------------------------------------------
// Output builders
// ---------------------------------------------------------------------------

/**
 * Map a {@link FitnessRecipeResult} onto the shared {@link CliOutput}
 * shape that the dashboard, JSON exporter, and SARIF builder all
 * consume. The same finding shape is produced here and in
 * {@link buildFitDoneResult} below so any change is paired.
 */
export function buildCliOutput(
  fitnessResult: FitnessRecipeResult,
  recipeName: string | undefined,
): CliOutput {
  const { summary, checkResults, durationMs } = fitnessResult;
  // Shared pass-rate helper — the live renderer, service.buildResult, and
  // graph all route through passRate() so gate baselines and the dashboard
  // can never disagree (a divergence here used to risk a phantom
  // --gate-compare regression).
  const score = passRate({ total: summary.totalChecks, passed: summary.passedChecks });
  return {
    version: '1.0',
    tool: 'fit',
    timestamp: new Date().toISOString(),
    recipe: recipeName,
    score,
    passed: summary.failedChecks === 0 && getPluginLoadErrors().length === 0,
    summary: {
      total: summary.totalChecks,
      passed: summary.passedChecks,
      failed: summary.failedChecks,
      errors: summary.totalErrors,
      warnings: summary.totalWarnings,
    },
    checks: checkResults.map(cr => ({
      checkSlug: cr.checkSlug,
      passed: cr.passed,
      violationCount: cr.violationCount,
      findings: (cr.violations ?? []).map(v => ({
        ruleId: cr.checkSlug,
        message: v.message,
        severity: v.severity,
        filePath: v.file,
        line: v.line,
        column: v.column,
        suggestion: v.suggestion,
      })),
      durationMs: cr.durationMs,
    })),
    durationMs,
  };
}

/** Input bundle for {@link buildFitDoneResult}: CLI args, recipe result, and signaler config. */
export interface BuildFitDoneArgs {
  args: FitOptions;
  fitnessResult: FitnessRecipeResult;
  signalersConfig: SignalersConfig;
  recipeName: string | undefined;
  warnings?: readonly string[];
}

/**
 * Build the {@link FitDoneResult} the live renderer / JSON output / gate
 * mode all consume. Computes the configured fail thresholds, the table
 * rows, the optional grouped findings block, and the run label.
 *
 * Pure builder: session persistence (SessionRepo.save) lives at the
 * `executeFit` call site (post-call), not here. Threading `datastore`
 * into `executeFit`'s opts in v2 made it unnecessary to push it into
 * this builder, and keeping the function side-effect-free preserves the
 * D1-phase decomposition. See `executeFit` for the persistence write.
 */
export function buildFitDoneResult({ args, fitnessResult, signalersConfig, recipeName, warnings }: BuildFitDoneArgs): FitDoneResult {
  const { summary, checkResults, durationMs } = fitnessResult;

  const tableRows: TableRow[] = checkResults.map(cr => ({
    check: getDisplayName(cr.checkSlug),
    status: rowStatus(cr),
    errors: cr.errorCount,
    warnings: cr.warningCount,
    validated: formatValidatedColumn(cr.totalItems, cr.itemType),
    ignored: cr.ignoredCount,
    duration: formatDuration(cr.durationMs),
    durationMs: cr.durationMs,
  }));

  const summaryOpts: SummaryOptions = {
    passed: summary.passedChecks,
    failed: summary.failedChecks,
    totalErrors: summary.totalErrors,
    totalWarnings: summary.totalWarnings,
    totalIgnored: summary.totalIgnored,
    durationMs,
  };

  // Determine exit code from config thresholds.
  // failOnErrors: fail if total errors >= this value (default: 1, 0 = never fail on errors)
  // failOnWarnings: fail if total warnings >= this value (default: 0 = never fail on warnings)
  const failOnErrors = signalersConfig.fitness.failOnErrors ?? 1;
  const failOnWarnings = signalersConfig.fitness.failOnWarnings ?? 0;
  const shouldFail =
    getPluginLoadErrors().length > 0 ||
    (failOnErrors > 0 && summary.totalErrors >= failOnErrors) ||
    (failOnWarnings > 0 && summary.totalWarnings >= failOnWarnings);

  let findings: FitDoneResult['findings'];
  if ((args.findings || args.verbose) && (summary.totalErrors + summary.totalWarnings) > 0) {
    findings = {
      checks: checkResults
        .filter(cr => cr.errorCount > 0 || cr.warningCount > 0 || cr.error)
        .map(cr => ({
          checkSlug: cr.checkSlug,
          passed: cr.passed,
          violationCount: cr.violationCount,
          findings: (cr.violations ?? []).map(v => ({
            ruleId: cr.checkSlug,
            message: v.message,
            severity: v.severity,
            filePath: v.file,
            line: v.line,
            column: v.column,
            suggestion: v.suggestion,
          })),
          durationMs: cr.durationMs,
          error: cr.error,
        })),
    };
  }

  const label = args.tags ? `tags: ${args.tags}` : `recipe ${recipeName ?? 'default'}`;

  return {
    type: 'fit-done',
    rows: tableRows,
    summary: summaryOpts,
    label,
    cwd: args.cwd,
    findings,
    shouldFail,
    configFound: true,
    warnings: warnings && warnings.length > 0 ? warnings : undefined,
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
 * with a `datastore` opt. Maps `CliOutput` directly onto the
 * `StoredSession` shape that `SessionRepo` consumes. Errors are caught
 * and logged so a write failure never fails the run.
 */
export function persistFitSession(
  datastore: DataStore,
  args: FitOptions,
  output: CliOutput,
): void {
  try {
    const repo = new SessionRepo(datastore);
    repo.save({
      id: generatePrefixedId('fit'),
      tool: 'fit',
      timestamp: output.timestamp,
      cwd: args.cwd,
      recipe: output.recipe,
      score: output.score,
      passed: output.passed,
      durationMs: output.durationMs,
      // Fitness-owned opaque detail (summary + per-check findings). The
      // generic session row above holds zero fitness vocabulary; the
      // dashboard reads this payload to render the Fitness tab.
      payload: buildFitnessSessionPayload(output),
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
