/**
 * render — static-render entry. Tool-agnostic; every tool that emits a
 * `CommandResult` reaches the user's terminal through this single seam.
 *
 * This is the one place that chooses the output medium: when stdout is a
 * TTY the result renders through Ink (themed; colorless under NO_COLOR via
 * the ThemeProvider); when stdout is piped/redirected/CI it renders as
 * plain text with no banner. Tools never make this choice — they return a
 * `CommandResult` and this seam picks Ink vs. text. (Migration is phased:
 * `resultToView` returns null for result types not yet expressed as a
 * view-model, and those still render through the legacy Ink App — TTY
 * only — until Phase 5 finishes the migration.)
 *
 * Every Ink/cli-ui import here is dynamic so this module loads no
 * React/Ink at startup — the hot `opensip-tools fit --json` path (which
 * uses `emitJson`, never this seam) stays React-free.
 */

import { currentScope } from '@opensip-tools/core';

import type { CommandResult } from '@opensip-tools/contracts';

/**
 * Render a `CommandResult` to the terminal, choosing Ink (TTY) or plain
 * text (non-TTY) at this single seam.
 *
 * Reads the project location from the entered `RunScope` for the Ink
 * shell's `ℹ Project:` line. Project-agnostic commands and scopeless
 * error/parse paths pass `undefined` → no project line. The plain-text
 * path emits no banner or project line by design (clean pipes/CI logs).
 */
export async function renderResult(result: CommandResult): Promise<void> {
  const scope = currentScope();
  const project = scope?.projectContext;
  const projectHeader =
    project?.scope === 'project'
      ? { root: project.projectRoot, walkedUp: project.walkedUp }
      : undefined;
  const ui = scope?.ui;

  // Non-TTY (pipe / redirect / CI): render migrated result types as plain
  // text with zero ANSI and no banner. Un-migrated types fall through to
  // the Ink path below until they are migrated.
  if (!process.stdout.isTTY) {
    const { resultToView } = await import('../ui/result-to-view.js');
    const view = resultToView(result);
    if (view !== null) {
      const { renderToText } = await import('@opensip-tools/cli-ui');
      process.stdout.write(`${renderToText(view)}\n`);
      return;
    }
  }

  const { renderApp } = await import('../ui/render.js');
  await renderApp(result, projectHeader, ui);
}
