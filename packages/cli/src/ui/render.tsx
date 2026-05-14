/**
 * render — entry point for Ink rendering.
 *
 * Two modes:
 * - renderApp(result): static rendering for completed command results
 * - renderFitView(args): stateful rendering with spinner → results transition
 */

import React from 'react';

import { App } from './App.js';
import { FitView } from './components/FitView.js';
import { ClockProvider } from './hooks/useClock.js';
import { ThemeProvider } from './theme.js';

import type { CommandResult , CliArgs } from '@opensip-tools/cli-shared';

/** Render a static command result (non-fit commands) */
export async function renderApp(result: CommandResult): Promise<void> {
  const { render } = await import('ink');

  const app = render(
    <ThemeProvider>
      <App result={result} />
    </ThemeProvider>,
  );

  app.unmount();
  // Trailing newline so shell prompt starts on a new line
  process.stdout.write('\n');
}

/** Render the fit command with real-time spinner → results transition */
export async function renderFitView(args: CliArgs): Promise<void> {
  const { render } = await import('ink');

  const app = render(
    <ThemeProvider>
      <ClockProvider>
        <FitView args={args} />
      </ClockProvider>
    </ThemeProvider>,
  );

  await app.waitUntilExit();
  // Trailing newline so shell prompt starts on a new line
  process.stdout.write('\n');
}

