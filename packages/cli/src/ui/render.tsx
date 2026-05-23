/**
 * render — entry point for Ink rendering.
 *
 * Three modes:
 * - renderApp(result): static rendering for completed command results
 * - renderFitView(args): stateful rendering with spinner → results transition
 * - renderGraphView(args): stage-checklist view for `graph` runs
 */

import React from 'react';

import { App } from './App.js';
import { FitView } from './components/FitView.js';
import { GraphView } from './components/GraphView.js';
import { ClockProvider } from './hooks/useClock.js';
import { ThemeProvider } from './theme.js';

// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; renderFitView consumes the CliArgs shape produced by fit's *OptsToCliArgs adapter until the rip-out
import type { CommandResult , CliArgs } from '@opensip-tools/contracts';

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
// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
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

export interface GraphViewArgs {
  readonly cwd: string;
  readonly noCache?: boolean;
}

/** Render the graph command with a live stage checklist. */
export async function renderGraphView(args: GraphViewArgs): Promise<void> {
  const { render } = await import('ink');

  const app = render(
    <ThemeProvider>
      <ClockProvider>
        <GraphView args={args} />
      </ClockProvider>
    </ThemeProvider>,
  );

  await app.waitUntilExit();
  process.stdout.write('\n');
}

