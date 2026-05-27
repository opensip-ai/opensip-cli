/**
 * fit-baseline-export command — write the SQLite-backed fit baseline
 * to a SARIF file on disk. Lets CI flows (`gh code-scanning upload-sarif`,
 * for example) consume the baseline without reading the datastore
 * directly, and lets customers commit a baseline to git if they want
 * git-trackable enforcement.
 *
 * The baseline lives in the `fit_baseline` table (single row, id=1)
 * with the SARIF document as the `sarif_payload` JSON column.
 * Exporting reads that row and writes the payload to disk verbatim.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { FitBaselineRepo } from '../persistence/baseline-repo.js';

import type { DataStore } from '@opensip-tools/datastore';

export interface FitBaselineExportResult {
  readonly type: 'fit-baseline-export';
  /** Absolute path the SARIF document was written to. */
  readonly outPath: string;
  /** Bytes written. */
  readonly bytesWritten: number;
}

export interface FitBaselineExportErrorResult {
  readonly type: 'error';
  readonly message: string;
  /** Exit code the caller should propagate (CONFIGURATION_ERROR / RUNTIME_ERROR). */
  readonly exitCode: number;
}

/**
 * Read the fit baseline from the datastore and write it to `outPath`.
 *
 * - If no baseline row exists, returns an error result. Customers
 *   running this before their first `fit --gate-save` would hit this.
 * - Parent directories of `outPath` are created (mkdir -p semantic).
 * - Existing files at `outPath` are overwritten — standard export
 *   behavior; a wrapper script that needs prompt-on-overwrite can
 *   stat first.
 */
export function exportFitBaseline(
  datastore: DataStore,
  outPath: string,
): FitBaselineExportResult | FitBaselineExportErrorResult {
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
  const serialized = JSON.stringify(payload, null, 2);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serialized, 'utf8');
  return {
    type: 'fit-baseline-export',
    outPath,
    bytesWritten: Buffer.byteLength(serialized, 'utf8'),
  };
}
