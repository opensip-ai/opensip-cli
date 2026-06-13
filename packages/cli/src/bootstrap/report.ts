/**
 * report — TTY/CI guarded auto-open of the HTML report after a
 * tool run.
 *
 * Tools call this through `ctx.maybeOpenReport`. Lives in `bootstrap/`
 * because the launch policy (TTY, JSON-mode, CI vars, `--open`) is
 * tool-agnostic.
 *
 * Audit 2026-05-29 (L2): the auto-open path now goes through the CLI's
 * own cross-tool composition (`composeAndWriteReport`) instead of
 * dynamically importing fitness's old report opener. The CLI is the
 * report composition root — it walks every registered tool's
 * `collectReportData` contribution and merges them. This removes the
 * last `cli → @opensip-cli/fitness` dynamic import from this path and
 * keeps fitness decoupled from graph.
 *
 * Extracted from the prior `render-helpers.ts` so the pure renderer
 * (`render.ts`) and this report auto-open helper can each evolve
 * without dragging the other along. Audit 2026-05-23 M4. The first-
 * party live-view map (`live-views.ts`) was deleted in Layer 5 Phase 3
 * (audit 2026-05-22 F3) — tool packages now own their own renderers.
 */

import { decideReportOpen } from '../open-report.js';
import { composeAndWriteReport } from '../report-compose.js';

/**
 * Open the HTML report in the user's browser when the run conditions
 * allow it (TTY, not JSON-mode, not CI, opt-in via --open). Tools call
 * this through `ctx.maybeOpenReport` after a run. Project root and the
 * per-tool report contributions both come from the entered RunScope
 * (read inside `composeAndWriteReport`) — single source of truth.
 */
export async function maybeOpenReport(opts: {
  openRequested: boolean;
  jsonOutput: boolean;
}): Promise<void> {
  const decision = decideReportOpen({
    openRequested: opts.openRequested,
    jsonOutput: opts.jsonOutput,
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  });
  if (!decision.shouldOpen) return;
  // Compose the cross-tool report and launch the browser. The CLI
  // owns composition; `composeAndWriteReport` reads `currentScope()`
  // for the tool registry + datastore and walks each tool's
  // `collectReportData`. No `@opensip-cli/fitness` import here.
  await composeAndWriteReport({ open: true });
}
