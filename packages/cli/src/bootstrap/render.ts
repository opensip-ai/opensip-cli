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

import { currentScope } from '@opensip-tools/core';

import type { CommandResult } from '@opensip-tools/contracts';

/**
 * Render a `CommandResult` via the static Ink app.
 *
 * Reads the project location from the entered `RunScope` (the static
 * render runs inside the pre-action hook's scope) and hands it to the
 * App shell, which renders the canonical `ℹ Project:` line under the
 * banner. Project-agnostic commands (scope ≠ 'project') and error/parse
 * paths with no scope pass `undefined` → no project line.
 */
export async function renderResult(result: CommandResult): Promise<void> {
  const scope = currentScope();
  const project = scope?.projectContext;
  const projectHeader =
    project?.scope === 'project'
      ? { root: project.projectRoot, walkedUp: project.walkedUp }
      : undefined;
  // Presentation settings (banner size + CLI version) resolved once in the
  // pre-action hook. Absent only on paths with no entered scope (e.g. a
  // pre-scope parse error) — App applies its own defaults then.
  const ui = scope?.ui;
  const { renderApp } = await import('../ui/render.js');
  await renderApp(result, projectHeader, ui);
}
