/* eslint-disable unicorn/filename-case -- React component test files mirror PascalCase component filenames */
/**
 * Tests for the top-level `App` dispatcher — covers the Phase 6 branches
 * `case 'clear-done':` and `case 'configure-done':` that previously
 * lived as raw ANSI prints inside the command implementations.
 */

import { ThemeProvider } from '@opensip-cli/cli-ui';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { App, type AppProps } from '../../ui/App.js';

import type {
  ClearDoneResult,
  ConfigureDoneResult,
  ReportResult,
  ErrorResult,
  HelpResult,
} from '@opensip-cli/contracts';

function renderApp(result: AppProps['result'], projectHeader?: AppProps['projectHeader']): string {
  const { lastFrame } = render(
    <ThemeProvider>
      <App result={result} projectHeader={projectHeader} />
    </ThemeProvider>,
  );
  return lastFrame() ?? '';
}

describe('App.tsx — clear-done branch', () => {
  it('renders the empty-state message and the banner', () => {
    const result: ClearDoneResult = {
      type: 'clear-done',
      action: 'empty',
      deletedCount: 0,
      sessionCount: 0,
    };
    const output = renderApp(result);
    expect(output).toContain('No session data to clear.');
    expect(output).toContain('www.opensip.ai');
  });

  it('renders the cancelled-state message', () => {
    const result: ClearDoneResult = {
      type: 'clear-done',
      action: 'cancelled',
      deletedCount: 0,
      sessionCount: 5,
    };
    const output = renderApp(result);
    expect(output).toContain('Cancelled. No data was deleted.');
  });

  it('renders a deletion-count line for action: done', () => {
    const result: ClearDoneResult = {
      type: 'clear-done',
      action: 'done',
      deletedCount: 3,
      sessionCount: 5,
    };
    const output = renderApp(result);
    expect(output).toContain('3 sessions deleted.');
  });

  it('uses singular "session" for a single deletion', () => {
    const result: ClearDoneResult = {
      type: 'clear-done',
      action: 'done',
      deletedCount: 1,
      sessionCount: 5,
    };
    const output = renderApp(result);
    expect(output).toContain('1 session deleted.');
  });
});

describe('App.tsx — configure-done branch', () => {
  it('renders the saved-state success line including the config path', () => {
    const result: ConfigureDoneResult = {
      type: 'configure-done',
      action: 'saved',
      configPath: '/Users/test/.opensip-cli/config.yml',
      maskedKey: 'abcd...wxyz',
    };
    const output = renderApp(result);
    expect(output).toContain('API key saved to');
    expect(output).toContain('config.yml');
  });

  it('renders the cancelled-state message when no key was provided', () => {
    const result: ConfigureDoneResult = {
      type: 'configure-done',
      action: 'cancelled',
      configPath: '/Users/test/.opensip-cli/config.yml',
    };
    const output = renderApp(result);
    expect(output).toContain('No key provided. Configuration unchanged.');
  });
});

describe('App.tsx — banner shell (single source of truth)', () => {
  const BANNER_MARKER = 'www.opensip.ai';

  it('renders the banner for report output (regression: the HTML report had no banner)', () => {
    const result: ReportResult = {
      type: 'report',
      path: '/repo/report.html',
      opened: false,
    };
    const output = renderApp(result);
    expect(output).toContain('Report written to');
    expect(output).toContain(BANNER_MARKER);
  });

  it('renders the banner for configure-done (gained via the shell)', () => {
    const result: ConfigureDoneResult = {
      type: 'configure-done',
      action: 'saved',
      configPath: '/Users/test/.opensip-cli/config.yml',
      maskedKey: 'abcd...wxyz',
    };
    expect(renderApp(result)).toContain(BANNER_MARKER);
  });

  it('renders the banner for help (D1: help is bannered)', () => {
    const result: HelpResult = { type: 'help' };
    expect(renderApp(result)).toContain(BANNER_MARKER);
  });

  it('does NOT render the banner for error (D1: errors stay terse)', () => {
    const result: ErrorResult = {
      type: 'error',
      message: 'Something went wrong',
      exitCode: 1,
    };
    const output = renderApp(result);
    expect(output).toContain('Something went wrong');
    expect(output).not.toContain(BANNER_MARKER);
  });
});

describe('App.tsx — project path in the banner', () => {
  it('renders the project path when project context is supplied', () => {
    const result: ReportResult = { type: 'report', path: '/repo/r.html', opened: false };
    const output = renderApp(result, { root: '/workspace/project', walkedUp: 0 });
    expect(output).toContain('/workspace/project');
    expect(output).not.toContain('ℹ Project:');
  });

  it('includes the walked-up suffix', () => {
    const result: ReportResult = { type: 'report', path: '/repo/r.html', opened: false };
    const output = renderApp(result, { root: '/repo', walkedUp: 2 });
    expect(output).toContain('/repo  (found 2 levels up)');
  });

  it('omits the project line for bannerless results (error), even with context', () => {
    const result: ErrorResult = { type: 'error', message: 'boom', exitCode: 1 };
    const output = renderApp(result, { root: '/repo', walkedUp: 0 });
    expect(output).not.toContain('ℹ Project:');
  });
});
