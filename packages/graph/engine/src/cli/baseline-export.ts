/**
 * graph-baseline-export command — write the SQLite-backed graph
 * baseline to a JSON file on disk. Lets CI flows consume the baseline
 * without reading the datastore directly, and lets customers commit a
 * baseline to git if they want git-trackable enforcement.
 *
 * The baseline lives in two tables:
 *   - `graph_baseline_meta` (existence marker, captured_at timestamp)
 *   - `graph_baseline_signals` (one row per fingerprint)
 *
 * Export reconstructs the v1 JSON shape that lived at
 * `<runtime>/cache/graph/baseline.json` before the SQLite migration,
 * so any external consumer that previously read the file directly can
 * read the exported file unchanged.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { sql } from 'drizzle-orm';

import { GraphBaselineRepo } from '../persistence/baseline-repo.js';
import { graphBaselineMeta } from '../persistence/schema.js';

import type { DataStore } from '@opensip-tools/datastore';

interface GraphBaselineFile {
  readonly version: '1';
  readonly tool: 'graph';
  /** ISO-8601 timestamp of when the baseline was captured. */
  readonly capturedAt: string;
  /** Sorted fingerprint set — preserves the v1 file's ordering. */
  readonly fingerprints: readonly string[];
}

export interface GraphBaselineExportResult {
  readonly type: 'graph-baseline-export';
  readonly outPath: string;
  readonly bytesWritten: number;
  readonly fingerprintCount: number;
}

export interface GraphBaselineExportErrorResult {
  readonly type: 'error';
  readonly message: string;
  readonly exitCode: number;
}

/**
 * Read the graph baseline from the datastore and write it to `outPath`
 * as the v1 file shape (version, tool, capturedAt, fingerprints[]).
 */
export function exportGraphBaseline(
  datastore: DataStore,
  outPath: string,
): GraphBaselineExportResult | GraphBaselineExportErrorResult {
  const repo = new GraphBaselineRepo(datastore);
  if (!repo.exists()) {
    return {
      type: 'error',
      message:
        `No graph baseline found in the datastore. ` +
        `Run \`opensip-tools graph --gate-save\` first to capture a baseline.`,
      exitCode: 2,
    };
  }
  // Read capturedAt from the existence-marker row directly. The repo
  // doesn't expose this today; a small raw query keeps the
  // repo's public surface stable.
  const metaRow = datastore.db
    .select({ capturedAt: graphBaselineMeta.capturedAt })
    .from(graphBaselineMeta)
    .where(sql`id = 1`)
    .get();
  // Defensive: exists() returned true above, so this should always be
  // a row, but a torn read in a concurrent session could theoretically
  // surprise us. Surface a structured error rather than crashing.
  if (!metaRow) {
    return {
      type: 'error',
      message: 'Graph baseline meta row missing after exists() reported present.',
      exitCode: 1,
    };
  }
  const fingerprints = repo.loadFingerprints();
  const file: GraphBaselineFile = {
    version: '1',
    tool: 'graph',
    capturedAt: new Date(metaRow.capturedAt).toISOString(),
    fingerprints,
  };
  const serialized = JSON.stringify(file, null, 2);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serialized, 'utf8');
  return {
    type: 'graph-baseline-export',
    outPath,
    bytesWritten: Buffer.byteLength(serialized, 'utf8'),
    fingerprintCount: fingerprints.length,
  };
}
