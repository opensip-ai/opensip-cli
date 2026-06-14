/**
 * report-compose — the cross-tool report composition root.
 *
 * Audit 2026-05-29 (L2): the CLI, not any single tool, composes the HTML
 * report. It walks every registered tool's `collectReportData(scope)`
 * contribution and merges the results into one HTML report input, then
 * renders the self-contained HTML via `@opensip-cli/dashboard` and
 * writes it to the project's reports directory.
 *
 * This is what decouples fitness from graph: fitness contributes only
 * its own catalogs (`checkCatalog` / `recipeCatalog` / `editorProtocol`)
 * and graph contributes only `graphCatalog`. Neither reaches into the
 * other; the CLI owns the merge because composition needs the tool
 * REGISTRY (`RunScope.tools`), which the tool-facing `ToolScope`
 * deliberately excludes.
 *
 * Why read `currentScope()` here and nowhere in the tool packages: the
 * `Tool` contract must not depend on `RunScope` (that would reintroduce
 * a kernel⟷tool cycle). The CLI is the only layer allowed to read the
 * concrete `RunScope` (which has `.tools`) — tools receive the narrower
 * `ToolScope` view as the `collectReportData` parameter.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  currentScope,
  resolveProjectPaths,
  SystemError,
  logger as defaultLogger,
} from '@opensip-cli/core';
import {
  generateDashboardHtml,
  type ContributedTab,
  type DashboardInput as HtmlReportInput,
} from '@opensip-cli/dashboard';
import { SessionRepo } from '@opensip-cli/session-store';

import { getCurrentProjectRoot } from './cli-context.js';
import { launchReport } from './open-report.js';

import type { ReportResult } from '@opensip-cli/contracts';
import type {
  DashboardTabContribution,
  Logger,
  ToolDashboardContribution,
} from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

/**
 * Host-reserved top-level keys on the dashboard input that a tool's
 * `collectReportData` must never set. `sessions` is the durable cross-tool run
 * history; `contributedTabs` is the host-owned per-run tab shell
 * (host-owned-run-timing Phase 5 §9.3). A tool that returns one of these is
 * ignored (best-effort) with a warning — it cannot clobber the host shell.
 */
const RESERVED_DASHBOARD_KEYS = new Set(['sessions', 'contributedTabs']);

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
function resolveContributedTabs(
  contributions: readonly { sessionId: string; tool: string; contribution: unknown }[],
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

/**
 * Build the merged HTML report input from every registered tool's
 * report-data contribution, on top of the shared session history.
 *
 * Sessions come from the CLI (cross-tool history); each tool's
 * `collectReportData` returns its own keyed inputs which are merged
 * onto the base via `Object.assign`. Contributions are best-effort: a
 * tool that omits `collectReportData`, or returns an empty object,
 * simply contributes nothing.
 *
 * @throws {Error} When called outside an entered `RunScope` (i.e. not inside
 *   a CLI action body), since session history and tool contributions both
 *   require the scope.
 */
async function composeReportInput(): Promise<HtmlReportInput> {
  const scope = currentScope();
  if (!scope) {
    // Use a typed error with code so the top-level handler + --json paths
    // produce a clean, consistent failure instead of a raw Error.
    throw new SystemError(
      'report composition requires an entered RunScope (run inside a CLI action body).',
      { code: 'SYSTEM.SCOPE.NOT_ENTERED' },
    );
  }

  const log = scope.logger ?? defaultLogger;
  const datastore = scope.datastore() as DataStore | undefined;
  const repo = datastore ? new SessionRepo(datastore) : undefined;
  const sessions = repo ? [...repo.list({ limit: 20 })] : [];

  // Durable per-run dashboard contributions (host-owned-run-timing Phase 5):
  // pull the rich tabs tools persisted keyed by these exact session ids. This
  // survives a later `opensip report` process — it does not rely on any
  // same-process in-memory state from the original run. Best-effort: a backend
  // that cannot list contributions yields none, and the report still composes.
  const contributedTabs = repo
    ? resolveContributedTabs(repo.listDashboardContributions(sessions.map((s) => s.id)), log)
    : [];

  const input: HtmlReportInput = { sessions, contributedTabs };

  for (const tool of scope.tools.list()) {
    const contribution = await tool.collectReportData?.(scope);
    if (contribution) {
      // Guardrail (host-owned-run-timing Phase 5 §9.3 / spec §8): tools must
      // never clobber host-owned top-level shell keys (`sessions`,
      // `contributedTabs`; future shell keys join RESERVED_DASHBOARD_KEYS).
      // Ignore with a warning (best-effort, like other contribution faults) —
      // the host owns the run history AND the per-run contributed tabs.
      const reserved = Object.keys(contribution).filter((k) => RESERVED_DASHBOARD_KEYS.has(k));
      if (reserved.length > 0) {
        void log.warn({
          evt: 'cli.report.compose.reserved_key_ignored',
          module: 'cli:report',
          tool: tool.metadata.id,
          keys: reserved,
          msg: 'Tool collectReportData returned a reserved host key; it was ignored.',
        });
        for (const k of reserved) delete contribution[k];
      }
      Object.assign(input, contribution);
    }
  }

  return input;
}

/**
 * Compose the cross-tool report, write it to
 * `<reportsDir>/latest.html`, and (optionally) open it in the browser.
 *
 * Returns a `ReportResult` describing the written path and whether a
 * browser was launched. Browser-launch failures never propagate — they
 * fall through to `opened: false` so the user can open the file manually.
 */
export async function composeAndWriteReport(opts: { open: boolean }): Promise<ReportResult> {
  const input = await composeReportInput();
  const html = generateDashboardHtml(input);

  const paths = resolveProjectPaths(getCurrentProjectRoot());
  mkdirSync(paths.reportsDir, { recursive: true });
  const reportPath = join(paths.reportsDir, 'latest.html');
  writeFileSync(reportPath, html, 'utf8');

  const opened = opts.open ? await launchReport(reportPath) : false;

  return { type: 'report', path: reportPath, opened };
}
