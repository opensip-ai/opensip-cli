/**
 * render — static-render entry. Tool-agnostic; every tool that emits a
 * `CommandResult` reaches the user's terminal through this single seam.
 *
 * Extracted from the prior `render-helpers.ts` so the pure renderer
 * doesn't co-locate with the first-party live-view map (transitional
 * shape) or the dashboard auto-open helper (fitness-tool-aware). Audit
 * 2026-05-23 M4.
 *
 * The dynamic import keeps Ink/React out of the cold-start path until a
 * command actually renders something — the hot `opensip-tools fit
 * --json` path stays React-free.
 */

import type { CommandResult } from '@opensip-tools/contracts';

/** Render a `CommandResult` via the static Ink app. */
export async function renderResult(result: CommandResult): Promise<void> {
  const { renderApp } = await import('../ui/render.js');
  await renderApp(result);
}
