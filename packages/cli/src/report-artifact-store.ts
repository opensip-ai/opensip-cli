/**
 * Atomic report artifact naming, writing, and orphan pruning.
 *
 * The composition layer supplies rendered HTML and retained Run identities;
 * this module owns filesystem effects and path-safe artifact names.
 */

import { createHash } from 'node:crypto';
import { readdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

import { writeArtifactAtomically } from './bootstrap/atomic-artifact-write.js';
import { resolveStateLockPolicy } from './bootstrap/state-lock-policy.js';

import type { Logger } from '@opensip-cli/core';

/** Domain-separated filename material for run-addressed report artifacts. */
const RUN_REPORT_FILENAME_DOMAIN = 'opensip-cli/report-run-artifact/v1\0';

/**
 * Fixed safe filename for a run-addressed report artifact.
 * Domain-separated SHA-256 of the opaque Run ID — never path-interpolated.
 */
export function runAddressedReportFilename(runId: string): string {
  const digest = createHash('sha256')
    .update(RUN_REPORT_FILENAME_DOMAIN)
    .update(runId)
    .digest('hex');
  return `${digest}.html`;
}

/**
 * Delete run-addressed report HTML whose Run is no longer retained.
 * Uncertainty preserves the file; only exact orphan digests are removed.
 */
export function pruneOrphanRunAddressedReports(
  reportsDir: string,
  retainedRunIds: readonly string[],
): number {
  const runsDir = join(reportsDir, 'runs');
  let entries: string[];
  try {
    entries = readdirSync(runsDir);
  } catch {
    // @swallow-ok missing runs dir is not an error; nothing to prune.
    return 0;
  }
  const kept = new Set(
    retainedRunIds
      .filter((id) => typeof id === 'string' && id.length > 0)
      .map((id) => runAddressedReportFilename(id)),
  );
  let removed = 0;
  for (const name of entries) {
    if (!/^[a-f0-9]{64}\.html$/.test(name)) continue;
    if (kept.has(name)) continue;
    try {
      unlinkSync(join(runsDir, name));
      removed += 1;
    } catch {
      // @swallow-ok concurrent delete / permission uncertainty preserves the file.
    }
  }
  return removed;
}

/** Atomically publish one HTML report under the current runtime lock policy. */
export function writeReportHtml(
  reportPath: string,
  html: string,
  input: {
    readonly logger: Logger;
    readonly runId?: string;
    readonly projectRoot?: string;
  },
): void {
  void writeArtifactAtomically(reportPath, html, {
    policy: resolveStateLockPolicy(),
    logger: input.logger,
    runId: input.runId,
    command: 'report',
    cwdBasename: basename(input.projectRoot ?? process.cwd()),
  });
}
