/**
 * fit-baseline-export command — write the SQLite-backed fit baseline
 * to a SARIF file on disk. Lets CI flows (`gh code-scanning upload-sarif`,
 * for example) consume the baseline without reading the datastore
 * directly, and lets customers commit a baseline to git if they want
 * git-trackable enforcement.
 *
 * The baseline lives in the `fit_baseline` table (single row, id=1) holding
 * the run's {@link SignalEnvelope} (ADR-0011 Phase 6 — no SARIF in the
 * datastore). Exporting reads that row and writes a SARIF document to disk via
 * the root `cli.writeSarif` seam — the ONE place that formats an envelope to
 * SARIF (the engine never imports `@opensip-tools/output`).
 */

import { FitBaselineRepo } from '../persistence/baseline-repo.js';

import type { ToolCliContext } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

export interface FitBaselineExportResult {
  readonly type: 'fit-baseline-export';
  /** Absolute path the SARIF document was written to. */
  readonly outPath: string;
}

export interface FitBaselineExportErrorResult {
  readonly type: 'error';
  readonly message: string;
  /** Exit code the caller should propagate (CONFIGURATION_ERROR / RUNTIME_ERROR). */
  readonly exitCode: number;
}

/**
 * Read the fit baseline envelope from the datastore and write it to `outPath`
 * as SARIF via the root `cli.writeSarif` seam.
 *
 * - If no baseline row exists, returns an error result. Customers
 *   running this before their first `fit --gate-save` would hit this.
 * - The root seam creates parent directories (mkdir -p) and overwrites an
 *   existing file — standard export behavior.
 */
export async function exportFitBaseline(
  datastore: DataStore,
  outPath: string,
  cli: ToolCliContext,
): Promise<FitBaselineExportResult | FitBaselineExportErrorResult> {
  const repo = new FitBaselineRepo(datastore);
  if (!repo.exists()) {
    return {
      type: 'error',
      message:
        `No fit baseline found in the datastore. ` +
        `Run \`opensip-tools fit --gate-save\` first to capture a baseline.`,
      exitCode: 2,
    };
  }
  const payload = repo.load();
  if (payload === null) {
    // Should be unreachable given exists() returned true, but defensive.
    return {
      type: 'error',
      message: 'Fit baseline row exists but payload could not be loaded.',
      exitCode: 1,
    };
  }
  // The stored payload is the run's SignalEnvelope; the root formats it to
  // SARIF (single SARIF path) and writes it to disk.
  await cli.writeSarif(payload, outPath);
  return {
    type: 'fit-baseline-export',
    outPath,
  };
}
