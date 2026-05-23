/**
 * dashboard — TTY/CI guarded auto-open of the HTML dashboard after a
 * tool run.
 *
 * Tools call this through `ctx.maybeOpenDashboard`. Lives in `bootstrap/`
 * because the launch policy (TTY, JSON-mode, CI vars, `--open`) is
 * tool-agnostic; the dashboard generator itself lives in fitness and is
 * dynamically imported so the hot `opensip-tools fit --json` path
 * never loads it.
 *
 * Extracted from the prior `render-helpers.ts` so the pure renderer
 * (`render.ts`) and the first-party live-view map (`live-views.ts`) can
 * each evolve without dragging the others along. Audit 2026-05-23 M4.
 */

import { decideOpen, launchBrowser } from '../open-dashboard.js';

/**
 * Open the HTML dashboard in the user's browser when the run conditions
 * allow it (TTY, not JSON-mode, not CI, opt-in via --open). Tools call
 * this through `ctx.maybeOpenDashboard` after a run.
 */
export async function maybeOpenDashboard(opts: {
  openRequested: boolean;
  jsonOutput: boolean;
  cwd: string;
}): Promise<void> {
  const decision = decideOpen({
    openRequested: opts.openRequested,
    jsonOutput: opts.jsonOutput,
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  });
  if (!decision.shouldOpen) return;
  // Lazy import — fitness's openDashboard pulls in the dashboard
  // generator; keep it off the cold-start path for `opensip-tools fit
  // --json`.
  const { openDashboard } = await import('@opensip-tools/fitness');
  const dash = await openDashboard(opts.cwd);
  if (dash.type === 'dashboard' && dash.path) {
    await launchBrowser(dash.path);
  }
}
