/**
 * render — static-render entry. Tool-agnostic; every tool that emits a
 * `CommandResult` reaches the user's terminal through this single seam.
 *
 * This is the one place that chooses the output medium: when stdout is a
 * TTY the result renders through Ink (themed; colorless under NO_COLOR via
 * the ThemeProvider); when stdout is piped/redirected/CI it renders as
 * plain text with no banner. Tools never make this choice — they return a
 * `CommandResult` and this seam picks Ink vs. text. `resultToView` is total
 * over the `CommandResult` union, so both media consume the same view-model.
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

  // Non-TTY (pipe / redirect / CI): render as plain text with zero ANSI
  // from the same view-model the Ink path uses. The ASCII banner is
  // suppressed (clean logs), but the `ℹ Project:` discovery line is kept
  // — CI output should still record which root was analyzed and how it was
  // found. `error` stays terse (no project line), matching the TTY shell.
  if (!process.stdout.isTTY) {
    const [{ resultToView }, { renderToText, viewProjectHeader, group }] = await Promise.all([
      import('../ui/result-to-view.js'),
      import('@opensip-tools/cli-ui'),
    ]);
    const body = resultToView(result);
    const node =
      projectHeader !== undefined && result.type !== 'error'
        ? group([viewProjectHeader(projectHeader), { kind: 'spacer' }, body])
        : body;
    process.stdout.write(`${renderToText(node)}\n`);
    return;
  }

  const { renderApp } = await import('../ui/render.js');
  await renderApp(result, projectHeader, ui);
}
