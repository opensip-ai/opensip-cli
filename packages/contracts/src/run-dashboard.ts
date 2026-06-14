/**
 * run-dashboard — the shared per-run {@link ToolDashboardContribution} builder
 * (host-owned-run-timing Phase 5 §7).
 *
 * Every first-party tool (fit / sim / graph) returns a `SignalEnvelope` for a
 * completed run; this helper turns that single envelope into the declarative
 * dashboard contribution the host persists (keyed by session id) and the
 * dashboard renders generically. The first-party tabs therefore travel the
 * EXACT same seam a third-party tool would use — the dashboard package never
 * learns a tool's vocabulary; it reads the declarative `view` + the inline
 * row data.
 *
 * The contribution carries:
 *   - a `cards` "run summary" tab (verdict: score / passed / failed / errors /
 *     warnings), and
 *   - a `table` "units" tab (one row per unit: slug, passed, findings, duration).
 *
 * Tab ids are namespaced by the producing tool (e.g. `fit-run-summary`,
 * `graph-run-units`) so they cannot collide across tools at composition time.
 * The catalogs (checkCatalog / graphRuleCatalog / …) stay on the
 * `collectReportData` path — this is the additive per-run panel only.
 */

import type { SignalEnvelope } from './signal-envelope.js';
import type { DashboardTabContribution, ToolDashboardContribution } from '@opensip-cli/core';

/** Options for {@link buildRunDashboardContribution}. */
export interface BuildRunDashboardOptions {
  /**
   * Stable kebab id prefix, namespaced by the producing tool — e.g. `'fit'`,
   * `'sim'`, `'graph'`. The helper appends `-run-summary` / `-run-units`, so a
   * tool's tab ids cannot collide with another tool's.
   */
  readonly idPrefix: string;
  /** Human label used in the summary tab title — e.g. `'Fitness'`. */
  readonly label: string;
}

/**
 * Build a tool's per-run {@link ToolDashboardContribution} from its run
 * envelope. Pure: no IO, no clock — it only reads `envelope.verdict` +
 * `envelope.units`. The `data` bag holds the inline rows the declarative views
 * reference via `dataKey`; the host persists the whole structure verbatim.
 */
export function buildRunDashboardContribution(
  envelope: SignalEnvelope,
  opts: BuildRunDashboardOptions,
): ToolDashboardContribution {
  const { idPrefix, label } = opts;
  const { verdict } = envelope;
  const summaryKey = `${idPrefix}RunSummary`;
  const unitsKey = `${idPrefix}RunUnits`;

  // One labeled card record for the verdict summary. Stored under `summaryKey`
  // as a single-row array (the renderer reads the first row for `cards`).
  const summaryRow: Record<string, unknown> = {
    score: verdict.score,
    passed: verdict.passed,
    total: verdict.summary.total,
    passedCount: verdict.summary.passed,
    failedCount: verdict.summary.failed,
    errors: verdict.summary.errors,
    warnings: verdict.summary.warnings,
  };

  // One table row per unit (check / scenario / rule). Findings = the unit's
  // violationCount when present (fit) else 0 (graph/sim units carry signals at
  // the run level, not per-unit counts).
  const unitRows: Record<string, unknown>[] = envelope.units.map((u) => ({
    slug: u.slug,
    passed: u.passed,
    findings: u.violationCount ?? 0,
    durationMs: u.durationMs,
  }));

  const summaryTab: DashboardTabContribution = {
    id: `${idPrefix}-run-summary`,
    title: `${label} — Latest Run`,
    order: 0,
    dataKey: summaryKey,
    view: {
      kind: 'cards',
      fields: [
        { key: 'score', label: 'Score', format: 'number' },
        { key: 'passed', label: 'Passed', format: 'boolean' },
        { key: 'total', label: 'Total Units', format: 'number' },
        { key: 'passedCount', label: 'Units Passed', format: 'number' },
        { key: 'failedCount', label: 'Units Failed', format: 'number' },
        { key: 'errors', label: 'Errors', format: 'number' },
        { key: 'warnings', label: 'Warnings', format: 'number' },
      ],
    },
  };

  const unitsTab: DashboardTabContribution = {
    id: `${idPrefix}-run-units`,
    title: `${label} — Units`,
    order: 1,
    dataKey: unitsKey,
    view: {
      kind: 'table',
      columns: [
        { key: 'slug', label: 'Unit', format: 'text' },
        { key: 'passed', label: 'Passed', format: 'boolean' },
        { key: 'findings', label: 'Findings', format: 'number' },
        { key: 'durationMs', label: 'Duration', format: 'duration' },
      ],
    },
  };

  return {
    data: {
      [summaryKey]: [summaryRow],
      [unitsKey]: unitRows,
    },
    tabs: [summaryTab, unitsTab],
  };
}
