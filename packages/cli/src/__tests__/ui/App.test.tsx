/* eslint-disable unicorn/filename-case -- React component test files mirror PascalCase component filenames */
/**
 * Tests for the top-level `App` dispatcher — covers the Phase 6 branches
 * `case 'clear-done':` and `case 'configure-done':` that previously
 * lived as raw ANSI prints inside the command implementations.
 */

import { ThemeProvider } from '@opensip-tools/cli-ui';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { App } from '../../ui/App.js';

import type { ClearDoneResult, ConfigureDoneResult } from '@opensip-tools/contracts';

function renderApp(result: Parameters<typeof App>[0]['result']): string {
  const { lastFrame } = render(
    <ThemeProvider>
      <App result={result} />
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
    // Banner block characters confirm the Ink banner rendered.
    expect(output).toContain('█');
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
      configPath: '/Users/test/.opensip-tools/config.yml',
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
      configPath: '/Users/test/.opensip-tools/config.yml',
    };
    const output = renderApp(result);
    expect(output).toContain('No key provided. Configuration unchanged.');
  });
});
