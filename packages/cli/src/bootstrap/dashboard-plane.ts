/**
 * dashboard-plane — the host's per-run dashboard-contribution plane
 * (host-owned-run-timing Phase 5 §7 / Phase 6 §6.1).
 *
 * Tools persist a {@link ToolDashboardContribution} keyed by their session id
 * (the run plane writes it via `SessionRepo.saveDashboardContribution`). This
 * module owns the READ side: turning the durable contributions for a set of
 * sessions into the flat {@link ContributedTab} list the dashboard renders
 * generically, plus the host-reserved top-level keys a tool's
 * `collectReportData` must never clobber. `report-compose` consumes both.
 *
 * Kept separate from `report-compose` (the cross-tool composition root) so the
 * contribution → tab transform — the one piece with real branching (namespacing,
 * duplicate-drop, inline-row resolution) — has its own narrow, testable home.
 */

import type {
  DashboardTabContribution,
  Logger,
  ToolDashboardContribution,
} from '@opensip-cli/core';
import type { ContributedTab } from '@opensip-cli/dashboard';

/**
 * Host-reserved top-level keys on the dashboard input that a tool's
 * `collectReportData` must never set. `sessions` is the durable cross-tool run
 * history; `contributedTabs` is the host-owned per-run tab shell
 * (host-owned-run-timing Phase 5 §9.3). A tool that returns one of these is
 * ignored (best-effort) with a warning — it cannot clobber the host shell.
 */
export const RESERVED_DASHBOARD_KEYS = new Set(['sessions', 'contributedTabs']);

/** One durable per-run dashboard contribution row, as `SessionRepo` lists them. */
export interface PersistedDashboardContribution {
  readonly sessionId: string;
  readonly tool: string;
  readonly contribution: unknown;
}

/**
 * Resolve the durable per-run dashboard contributions (host-owned-run-timing
 * Phase 5 §7.3) for the given sessions into the flat {@link ContributedTab}
 * list the dashboard renders generically.
 *
 * Each contribution's tab is namespaced by its producing tool id
 * (`contrib-<tool>-<tabId>`) so one tool cannot collide with another's tab — or
 * with a registered tool tab / the overview shell. A duplicate namespaced id
 * within a single report is dropped with a warning (best-effort; never corrupts
 * the output). The view's inline rows are resolved from the contribution's
 * `data[dataKey]` (always coerced to an array; `cards` reads `rows[0]`).
 */
export function resolveContributedTabs(
  contributions: readonly PersistedDashboardContribution[],
  log: Logger,
): ContributedTab[] {
  const tabs: ContributedTab[] = [];
  const seen = new Set<string>();
  for (const entry of contributions) {
    const dashboard = entry.contribution as ToolDashboardContribution | null | undefined;
    const contributedTabs = dashboard?.tabs;
    if (!Array.isArray(contributedTabs)) continue;
    const data = dashboard?.data ?? {};
    for (const tab of contributedTabs as readonly DashboardTabContribution[]) {
      const resolved = resolveOneTab(entry.tool, tab, data, seen, log);
      if (resolved) tabs.push(resolved);
    }
  }
  return tabs;
}

/**
 * Resolve a single {@link DashboardTabContribution} into a {@link ContributedTab}
 * (namespaced id + resolved inline rows), or `undefined` when the namespaced id
 * collides with one already produced this report (warn + drop).
 */
function resolveOneTab(
  tool: string,
  tab: DashboardTabContribution,
  data: Record<string, unknown>,
  seen: Set<string>,
  log: Logger,
): ContributedTab | undefined {
  const namespacedId = `contrib-${tool}-${tab.id}`;
  if (seen.has(namespacedId)) {
    void log.warn({
      evt: 'cli.report.compose.duplicate_tab_dropped',
      module: 'cli:report',
      tool,
      tabId: tab.id,
      namespacedId,
      msg: 'Duplicate contributed dashboard tab id; the later one was dropped.',
    });
    return undefined;
  }
  seen.add(namespacedId);
  const rawRows = tab.dataKey === undefined ? undefined : data[tab.dataKey];
  const rows = Array.isArray(rawRows)
    ? (rawRows as Record<string, unknown>[])
    : ([] as Record<string, unknown>[]);
  return {
    id: namespacedId,
    title: tab.title,
    order: tab.order ?? 0,
    view: tab.view as ContributedTab['view'],
    rows,
  };
}
