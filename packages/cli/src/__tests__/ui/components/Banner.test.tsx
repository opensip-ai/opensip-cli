/* eslint-disable unicorn/filename-case -- React component test files mirror PascalCase component filenames */
import { Banner, ThemeProvider } from '@opensip-cli/cli-ui';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

describe('Banner', () => {
  it('renders the boxed coffee-cup identity card', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <Banner />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).toContain('OpenSIP CLI');
    expect(output).toContain('www.opensip.ai');
    expect(output).toContain('╭');
    expect(output).toContain('╯');
    expect(output).toContain('███');
    expect(output).not.toContain('\u2591');
  });

  it('renders the fixed-height identity card', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <Banner />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    const lines = output.split('\n');
    expect(lines).toHaveLength(6);
  });
});
