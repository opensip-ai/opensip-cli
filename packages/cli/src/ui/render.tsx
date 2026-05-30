/**
 * render — entry point for the CLI's static Ink rendering.
 *
 * Single responsibility: render a completed `CommandResult` through the
 * tool-agnostic `App` component. Tools that drive a stateful live view
 * (fitness, graph) own their own renderers in their packages and
 * register them via `cli.registerLiveView`; this file no longer mounts
 * any tool-specific component. Layer 5 Phase 3 (audit 2026-05-23 F3).
 */

import { ThemeProvider } from '@opensip-tools/cli-ui';
import React from 'react';

import { App, type ProjectHeaderProps } from './App.js';

import type { CommandResult } from '@opensip-tools/contracts';

/** Render a static command result. */
export async function renderApp(
  result: CommandResult,
  projectHeader?: ProjectHeaderProps,
): Promise<void> {
  const { render } = await import('ink');

  const app = render(
    <ThemeProvider>
      <App result={result} projectHeader={projectHeader} />
    </ThemeProvider>,
  );

  app.unmount();
  // Trailing newline so shell prompt starts on a new line
  process.stdout.write('\n');
}
