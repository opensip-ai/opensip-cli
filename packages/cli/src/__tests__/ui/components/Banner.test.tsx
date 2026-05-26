/* eslint-disable unicorn/filename-case -- React component test files mirror PascalCase component filenames */
import { Banner, ThemeProvider } from '@opensip-tools/cli-ui';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';


describe('Banner', () => {
  it('renders the ASCII art banner with block characters', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <Banner />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    // Banner uses block characters like U+2588 (full block)
    expect(output).toContain('\u2588');
    // Banner saucer line is present
    expect(output).toContain('\u2591');
  });

  it('renders multiple lines of banner art', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <Banner />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    const lines = output.split('\n');
    // Banner has 8 art lines + 1 saucer line = 9 minimum
    expect(lines.length).toBeGreaterThanOrEqual(9);
  });
});
