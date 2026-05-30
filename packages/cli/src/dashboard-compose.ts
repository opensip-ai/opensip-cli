/**
 * dashboard-compose — the cross-tool dashboard composition root.
 *
 * Audit 2026-05-29 (L2): the CLI, not any single tool, composes the HTML
 * report. It walks every registered tool's `collectDashboardData(scope)`
 * contribution and merges the results into one `DashboardInput`, then
 * renders the self-contained HTML via `@opensip-tools/dashboard` and
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
 * `ToolScope` view as the `collectDashboardData` parameter.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SessionRepo, type DashboardResult } from '@opensip-tools/contracts';
import { currentScope, resolveProjectPaths } from '@opensip-tools/core';
import { generateDashboardHtml, type DashboardInput } from '@opensip-tools/dashboard';

import { getCurrentProjectRoot } from './cli-context.js';
import { launchBrowser } from './open-dashboard.js';

import type { DataStore } from '@opensip-tools/datastore';

/**
 * Build the merged `DashboardInput` from every registered tool's
 * dashboard-data contribution, on top of the shared session history.
 *
 * Sessions come from the CLI (cross-tool history); each tool's
 * `collectDashboardData` returns its own keyed inputs which are merged
 * onto the base via `Object.assign`. Contributions are best-effort: a
 * tool that omits `collectDashboardData`, or returns an empty object,
 * simply contributes nothing.
 */
async function composeDashboardInput(): Promise<DashboardInput> {
  const scope = currentScope();
  if (!scope) {
    throw new Error(
      'dashboard composition requires an entered RunScope (run inside a CLI action body).',
    );
  }

  const datastore = scope.datastore() as DataStore | undefined;
  const sessions = datastore ? [...new SessionRepo(datastore).list({ limit: 20 })] : [];

  const input: DashboardInput = { sessions };

  for (const tool of scope.tools.list()) {
    const contribution = await tool.collectDashboardData?.(scope);
    if (contribution) Object.assign(input, contribution);
  }

  return input;
}

/**
 * Compose the cross-tool dashboard, write it to
 * `<reportsDir>/latest.html`, and (optionally) open it in the browser.
 *
 * Returns a `DashboardResult` describing the written path and whether a
 * browser was launched. Browser-launch failures never propagate — they
 * fall through to `opened: false` so the user can open the file manually.
 */
export async function composeAndWriteDashboard(opts: { open: boolean }): Promise<DashboardResult> {
  const input = await composeDashboardInput();
  const html = generateDashboardHtml(input);

  const paths = resolveProjectPaths(getCurrentProjectRoot());
  mkdirSync(paths.reportsDir, { recursive: true });
  const reportPath = join(paths.reportsDir, 'latest.html');
  writeFileSync(reportPath, html, 'utf8');

  const opened = opts.open ? await launchBrowser(reportPath) : false;

  return { type: 'dashboard', path: reportPath, opened };
}
