/**
 * render-helpers — Ink render entrypoints + first-party live-view map.
 *
 * The CLI owns the React/Ink layer; tools call back into these via
 * `ToolCliContext`. Extracted from `index.ts` so the dispatcher's
 * composition root reads top-to-bottom as wiring rather than inlining
 * dynamic-import boilerplate.
 *
 * The dynamic imports keep the Ink/React modules out of the cold-start
 * path until a command actually renders something — the hot
 * `opensip-tools fit --json` path stays React-free.
 */

import { fitnessTool } from '@opensip-tools/fitness';
import { graphTool } from '@opensip-tools/graph';

import { decideOpen, launchBrowser } from '../open-dashboard.js';

import type { CommandResult } from '@opensip-tools/contracts';
import type { LiveViewRenderer } from '@opensip-tools/core';

/** Render a `CommandResult` via the static Ink app. */
export async function renderResult(result: CommandResult): Promise<void> {
  const { renderApp } = await import('../ui/render.js');
  await renderApp(result);
}

/** First-party live-view renderers, keyed by `Tool.metadata.id`. */
export const builtinLiveViews: ReadonlyMap<string, LiveViewRenderer> = new Map<string, LiveViewRenderer>([
  [
    fitnessTool.metadata.id,
    async (args) => {
      const { renderFitView } = await import('../ui/render.js');
      await renderFitView(args as Parameters<typeof renderFitView>[0]);
    },
  ],
  [
    graphTool.metadata.id,
    async (args) => {
      const { renderGraphView } = await import('../ui/render.js');
      await renderGraphView(args as Parameters<typeof renderGraphView>[0]);
    },
  ],
]);

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
