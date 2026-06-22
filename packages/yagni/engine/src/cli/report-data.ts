/**
 * report-data contribution — yagni's inputs to the cross-tool HTML report.
 */

import { YAGNI_DETECTORS } from '../detectors/registry.js';

import type { ToolScope } from '@opensip-cli/core';

/** Detector catalog entry for the dashboard. */
export interface YagniDetectorCatalogEntry {
  readonly id: string;
  readonly slug: string;
  readonly description: string;
  readonly requiresGraph: boolean;
}

/** Static summary of the bundled detector catalog. */
export interface YagniSummaryCatalog {
  readonly detectorCount: number;
  readonly graphBackedCount: number;
  readonly contractVersion: string;
}

/**
 * Yagni's report-data contribution. Returns detector catalog + summary under
 * yagni-namespaced keys the dashboard consumes.
 */
export function collectYagniReportData(_scope: ToolScope): Record<string, unknown> {
  const yagniCatalog: YagniDetectorCatalogEntry[] = YAGNI_DETECTORS.map((d) => ({
    id: d.id,
    slug: d.slug,
    description: d.description,
    requiresGraph: d.requiresGraph,
  }));
  const yagniSummary: YagniSummaryCatalog = {
    detectorCount: YAGNI_DETECTORS.length,
    graphBackedCount: YAGNI_DETECTORS.filter((d) => d.requiresGraph).length,
    contractVersion: '1.0.0',
  };
  return { yagniCatalog, yagniSummary };
}
