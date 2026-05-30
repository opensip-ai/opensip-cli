/**
 * dashboard — TTY/CI guarded auto-open of the HTML dashboard after a
 * tool run.
 *
 * Tools call this through `ctx.maybeOpenDashboard`. Lives in `bootstrap/`
 * because the launch policy (TTY, JSON-mode, CI vars, `--open`) is
 * tool-agnostic.
 *
 * Audit 2026-05-29 (L2): the auto-open path now goes through the CLI's
 * own cross-tool composition (`composeAndWriteDashboard`) instead of
 * dynamically importing fitness's `openDashboard`. The CLI is the
 * dashboard composition root — it walks every registered tool's
 * `collectDashboardData` contribution and merges them. This removes the
 * last `cli → @opensip-tools/fitness` dynamic import from this path and
 * keeps fitness decoupled from graph.
 *
 * Extracted from the prior `render-helpers.ts` so the pure renderer
 * (`render.ts`) and this dashboard auto-open helper can each evolve
 * without dragging the other along. Audit 2026-05-23 M4. The first-
 * party live-view map (`live-views.ts`) was deleted in Layer 5 Phase 3
 * (audit 2026-05-22 F3) — tool packages now own their own renderers.
 */

import { composeAndWriteDashboard } from '../dashboard-compose.js';
import { decideOpen } from '../open-dashboard.js';

/**
 * Open the HTML dashboard in the user's browser when the run conditions
 * allow it (TTY, not JSON-mode, not CI, opt-in via --open). Tools call
 * this through `ctx.maybeOpenDashboard` after a run. Project root and the
 * per-tool dashboard contributions both come from the entered RunScope
 * (read inside `composeAndWriteDashboard`) — single source of truth.
 */
export async function maybeOpenDashboard(opts: {
  openRequested: boolean;
  jsonOutput: boolean;
}): Promise<void> {
  const decision = decideOpen({
    openRequested: opts.openRequested,
    jsonOutput: opts.jsonOutput,
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  });
  if (!decision.shouldOpen) return;
  // Compose the cross-tool dashboard and launch the browser. The CLI
  // owns composition; `composeAndWriteDashboard` reads `currentScope()`
  // for the tool registry + datastore and walks each tool's
  // `collectDashboardData`. No `@opensip-tools/fitness` import here.
  await composeAndWriteDashboard({ open: true });
}
