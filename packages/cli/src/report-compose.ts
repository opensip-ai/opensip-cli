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

import { currentScope, resolveProjectPaths, SystemError, logger as defaultLogger } from '@opensip-cli/core';
import {
  generateDashboardHtml,
  type DashboardInput as HtmlReportInput,
} from '@opensip-cli/dashboard';
import { SessionRepo } from '@opensip-cli/session-store';

import { getCurrentProjectRoot } from './cli-context.js';
import { launchReport } from './open-report.js';

import type { ReportResult } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

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

  const datastore = scope.datastore() as DataStore | undefined;
  const sessions = datastore ? [...new SessionRepo(datastore).list({ limit: 20 })] : [];

  const input: HtmlReportInput = { sessions };

  for (const tool of scope.tools.list()) {
    const contribution = await tool.collectReportData?.(scope);
    if (contribution) {
      // Guardrail (host-owned-run-timing Phase 6 + spec §8): tools must never
      // clobber host-owned top-level keys (sessions today; future may add more
      // like runTiming). Ignore with warning (best-effort, like other contribution
      // faults). The host `sessions` list is the durable history for the report.
      const reserved = Object.keys(contribution).filter((k) => k === 'sessions');
      if (reserved.length > 0) {
        (scope.logger ?? defaultLogger).warn({
          evt: 'cli.report.compose.reserved_key_ignored',
          module: 'cli:report',
          tool: tool.metadata.id,
          keys: reserved,
          msg: 'Tool collectReportData returned a reserved host key; it was ignored.',
        });
        for (const k of reserved) delete (contribution as any)[k];
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
