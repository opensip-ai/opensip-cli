/* eslint-disable unicorn/filename-case -- React component test files mirror PascalCase component filenames */
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { ErrorMessage } from '../../../ui/components/ErrorMessage.js';
import { ThemeProvider } from '../../../ui/theme.js';

describe('ErrorMessage', () => {
  it('renders the error message', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <ErrorMessage message="something failed" />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).toContain('something failed');
  });

  it('renders the suggestion when provided', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <ErrorMessage message="something failed" suggestion="try again" />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).toContain('something failed');
    expect(output).toContain('try again');
  });

  it('does not render suggestion when not provided', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <ErrorMessage message="something failed" />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).toContain('something failed');
    // Only the error line, no suggestion line
    const lines = output.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
  });

  it('renders the cross mark symbol', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <ErrorMessage message="bad" />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    // U+2717 cross mark
    expect(output).toContain('\u2717');
  });
});
